import Queue, { modeWhenFull } from './buffers'

type Fn = (...args: any[]) => any

interface IOpts {
  buffers?: Queue<IItem>
  size?: number
  mode?: number
  name?: string
  transform?: Fn
}

const RESOLVED = Symbol('resolved')
interface IItem {
  data?: any
  promise?: Promise<any>
  resolve: Fn
  [RESOLVED]?: ItemState
  id?: number
}

enum ChannelState {
  open,
  closing,
  closed,
  ended,
}

enum ItemState {
  pending,
  resolving,
  resolved,
}

export function* range(min?: number, max?: number, step: number = 1) {
  if (typeof max !== 'number') {
    ;[min = 0, max, step = 1] = [0, min, max]
  }

  const compare =
    min <= max && step > 0 ? (a, b) => a <= b : min >= max && step < 0 ? (a, b) => a >= b : null
  if (!compare) {
    return
  }

  while (compare(min, max)) {
    yield min
    min += step
  }
}

export function createAction(payload = {}): IItem {
  const item = { ...payload, resolve: null, promise: null, [RESOLVED]: ItemState.pending }
  item.promise = new Promise<any>((resolve, reject) => {
    item.resolve = (...args) => {
      if (item[RESOLVED] === ItemState.resolved) {
        return
      }

      item[RESOLVED] = ItemState.resolved
      resolve(...args)
    }
  })

  return item
}

const uuid = (i => () => i++)(0)
const { hasOwnProperty } = Object.prototype
export const debug = (...arg) => Channel.isDebug && console.log(...arg)

export class Channel {
  public static CLOSED = Symbol('CLOSED')
  public static ENDED = Symbol('ENDED')
  public static isDebug = true
  public static from(iterable, keepOpen: boolean = false) {
    const arr = [...iterable]
    const channel = new Channel({ size: arr.length })
    arr.forEach(v => channel.put(v))
    if (!keepOpen) {
      channel.close()
    }

    return channel
  }
  public name: string
  public id: number // 方便调试
  public buffers: Queue<IItem> = null
  public puts: IItem[]
  public takes: IItem[]
  public transform: Fn
  public pipes: Channel[]
  public ends: IItem[]
  public state: ChannelState
  public flowing: boolean = null
  private consumePromise: Promise<any>
  private endPromise: Promise<any>
  private closedAction: IItem

  constructor({
    buffers = null,
    size = null,
    mode = modeWhenFull.fixed,
    name = '',
    transform = null,
  }: IOpts = {}) {
    this.id = uuid()
    this.name = name || this.id.toString()
    this.buffers = buffers instanceof Queue ? buffers : new Queue<IItem>(size, mode)
    this.transform = transform
    this.takes = []
    this.puts = []
    this.pipes = []
    this.ends = []
    this.state = ChannelState.open
    this.endPromise = this.end()
  }

  public createAction(payload = {}): IItem {
    return createAction({ ...payload, id: this.id })
  }

  public put(data): Promise<any> {
    if (this.isClosed()) {
      return Promise.resolve(Channel.CLOSED)
    }

    const item = hasOwnProperty.call(data, RESOLVED)
      ? data
      : this.createAction({ data, type: 'put' })
    this.puts.push(item)
    this.consume()

    return item.promise
  }

  public take(action?: IItem): Promise<any> {
    if (!action) {
      action = this.createAction({ type: 'take' })
    }

    if (this.isClosed() && this.isEmpty()) {
      action.id = this.id
      action.resolve(Channel.CLOSED)
      return action.promise
    }

    if (action[RESOLVED]) {
      // action[RESOLVED] !== ItemState.pending
      return action.promise
    }

    this.takes.push(action)
    this.consume()

    return action.promise
  }

  public remove(promise): boolean {
    const { buffers, puts } = this
    const queues = [puts, buffers]

    queues.forEach(queue => {
      let length = queue.length
      while (length--) {
        const item = queue[length]
        if (item.promise === promise) {
          queue.splice(length, 1)
          return true
        }
      }
    })

    return true
  }

  public end(): Promise<any> {
    if (this.isEnd()) {
      return Promise.resolve(Channel.ENDED)
    }

    const item = this.createAction({ type: 'end' })
    this.ends.push(item)

    return item.promise
  }

  public async consume(): Promise<any> {
    // 正在执行且未resolve的返回
    if (this.consumePromise) {
      return this.consumePromise
    }

    // 重新执行
    this.consumePromise = Promise.resolve(true).then(() => this.execConsume())
    return this.consumePromise
  }

  private fillBuffer(puts = this.puts): boolean {
    // 转入缓冲区
    const { buffers } = this
    if (!puts.length) {
      return false
    }

    while (puts.length) {
      if (buffers.isFull() && buffers.mode === modeWhenFull.fixed) {
        break
      }

      const putItem = puts.shift()
      const retItem = buffers.push(putItem)
      if (retItem === false) {
        // droping 未入队
        putItem.resolve(false)
      } else if (typeof retItem === 'object') {
        // sliding, 队首位被删除
        retItem.resolve()
      } else {
        // true 正常入队
        putItem.resolve(true)
      }
    }

    return true
  }

  private async execConsume(): Promise<any> {
    const { buffers, takes, transform } = this
    let lastPromise = Promise.resolve(true)

    // 消费(put，take)
    while (takes.length) {
      if (!buffers.length || !this.fillBuffer()) {
        break
      }

      const takeItem = takes.shift()
      if (takeItem[RESOLVED] === ItemState.pending) {
        const putItem = buffers.shift()

        takeItem[RESOLVED] = ItemState.resolving
        takeItem.id = this.id // select 用到
        // 先take，再put
        lastPromise = lastPromise.then(async () => {
          takeItem.resolve(transform ? await transform(putItem.data) : putItem.data)
          putItem.resolve()

          return true
        })
      }
    }

    // 无put数据，清除已经resolved的take， select(ch1, ch2)
    if (this.isEmpty() && this.isClosed()) {
      // 排到上面最后一个promise后， 保证日志输出顺序
      await lastPromise
      debug(this.toString(), ' channel关闭且无数据状态，通知end监听 ')
      await this.finish()
    }

    this.consumePromise = null
    return true
  }

  // 通知未处理的take, put
  public flush(queues, val) {
    queues.forEach(queue => {
      if (!queue || !queue.length) {
        return
      }

      while (queue.length) {
        const item = queue.shift()

        if (!item[RESOLVED]) {
          item.id = this.id
          item.resolve(val)
        }
      }
    })

    return true
  }

  // 关闭put且无数据，则通知end
  private async finish() {
    try {
      const { ends } = this

      while (ends.length) {
        const { resolve } = ends.shift()
        resolve()
      }
    } catch (e) {
      console.log(e)
    }

    return true
  }

  public pipe(channels: Channel[] | Channel, keepAllSync: boolean = false): Channel {
    if (!Array.isArray(channels)) {
      channels = [channels]
    }

    channels = channels
      .map(x =>
        x instanceof Channel ? x : typeof x === 'function' ? new Channel({ transform: x }) : null
      )
      .filter(x => !!x && x !== this)

    if (channels.length) {
      this.pipes.push(...channels)
      this.flow(keepAllSync)

      return channels[channels.length - 1]
    }

    return this
  }

  public unpipe(...channels): Channel {
    channels.forEach(x => {
      const index = this.pipes.findIndex(y => y === x)
      if (index > -1) {
        this.pipes.splice(index, 1)
      }
    })

    if (!this.pipes.length || this.state === ChannelState.closed) {
      this.flowing = false
    }

    return this
  }

  public merge(...channels: Channel[]): Channel {
    const newChan = new Channel()

    channels.forEach(x => {
      if (x instanceof Channel) {
        x.pipe(newChan)
      }
    })

    return newChan
  }

  /**
   *
   * @param keepTaking : 关闭后可否继续读取buffer中的data，默认清空buffer，take收到closed
   */
  public async close(keepTaking = false): Promise<boolean> {
    if (this.closedAction) {
      return this.closedAction.promise
    }

    this.closedAction = this.createAction({ type: 'close' })
    this.state = ChannelState.closing
    if (keepTaking) {
      // new channel()后立即close
      this.consume()
      await this.endPromise
    }
    this.flush([this.buffers, this.puts, this.takes], Channel.CLOSED)
    this.state = ChannelState.closed

    this.closedAction.resolve()
    return this.closedAction.promise
  }

  public isEmpty() {
    return !this.buffers.length && !this.puts.length
  }

  public isClosed(): boolean {
    return (
      this.state === ChannelState.closing ||
      this.state === ChannelState.closed ||
      this.state === ChannelState.ended
    )
  }

  public isEnd(): boolean {
    return this.state === ChannelState.closed
  }

  private async flow(keepAllSync) {
    if (this.flowing || this.isClosed()) {
      return true
    }

    this.flowing = true
    while (this.flowing) {
      const val = await this.take()
      if (val === Channel.CLOSED && this.isClosed()) {
        this.flowing = false
        if (keepAllSync) {
          this.pipes.forEach(channel => channel.close())
        }

        break
      }

      // 等待所有pipe的channel都take后才put下一个， 有消费才继续流动
      // 不挂起 await Promise.all(this.pipes.map(channel => channel.put(val)))
      this.pipes.forEach(channel => channel.put(val))
    }

    return true
  }

  public async repeatTake(asycFn: (...args) => Promise<any>, concurrent: number = 1) {
    const tasks = [...range(1, Math.max(1, concurrent))]

    await Promise.race(
      tasks.map(async i => {
        try {
          while (true) {
            const val = await this.take()
            // 控制 asyncFn 只收一个 closed
            // if (typeof asycFn === 'function') {
            //   const promise = asycFn(val, i)
            //   if (val === Channel.CLOSED) {
            //     asycFn = null
            //   }
            //
            //   await promise
            // }

            if (val === Channel.CLOSED) {
              return Channel.CLOSED
            }

            // 与上面互斥
            await asycFn(val, i)
          }
        } catch (e) {
          console.log(e)
        }
      })
    )

    return Channel.CLOSED
  }

  public async *range() {
    try {
      while (true) {
        const val = await this.take()
        if (val === Channel.CLOSED) {
          return Channel.CLOSED
        }

        yield val
      }
    } catch (e) {
      console.log(e)
    }

    return Channel.CLOSED
  }

  public toString() {
    return `channel【${this.id}】_【${this.name}】`
  }
}

export function chan(...args) {
  return new Channel(...args)
}

export function put(channel: Channel, data: any) {
  return channel.put(data)
}

export function take(channel: Channel) {
  return channel.take()
}

export function sleep(ms: number) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * 取channels的值，ignoreClose 忽略CLOSED值:
 *    为true，则直到所有channel状态为closed了，才返回 CLOSED
 *    为false, 则只要取到就返回
 * @param channels
 */
// export async function select(channels: Channel[], ignoreClose = false) : Promise<[any, Channel]>  {
//   channels = channels.filter( (ch:Channel) => ch instanceof Channel && (!ch.isClosed() || !ch.isEmpty()) )
//   if(!channels.length){
//     return [Channel.CLOSED, null]
//   }
//
//    let val, action, channel
//
//    do {
//     action = createAction()
//     channels.forEach(ch => ch.take(action))
//
//     val = await action.promise
//     channel = channels.find(ch => ch.id === action.id)
//     if(!ignoreClose || val !== Channel.CLOSED){
//       break
//     }
//
//     channels = channels.filter(ch => ch.id !== action.id)
//   }while (channels.length)
//
//
//   return [val, channel]
// }

export async function select(
  channels: Channel[] | Channel,
  ignoreClose: boolean = false
): Promise<[any, Channel]> {
  if (!Array.isArray(channels)) {
    channels = [channels]
  }

  channels = channels.filter((ch: Channel) => ch instanceof Channel && !ch.isClosed())
  if (!channels.length) {
    return [Channel.ENDED, null]
  }

  do {
    const action = createAction({ type: 'take' })
    const [val, channel] = await Promise.race(channels.map(async ch => [await ch.take(action), ch]))

    if (val !== Channel.CLOSED || !ignoreClose) {
      return [val, channel]
    }

    if (val === Channel.CLOSED) {
      channels = channels.filter(ch => ch !== channel)
    }
  } while (channels.length)

  return [Channel.ENDED, null]
}

export async function repeatTake(channel: Channel, asycFn: Fn, concurrent: number = 1) {
  return channel.repeatTake(asycFn, concurrent)

  // if (concurrent <= 0) {
  //   return Channel.CLOSED // []
  // }
  //
  // const childGo = go(channel, asycFn, concurrent - 1)
  //
  // try {
  //   while (true) {
  //     const val = await channel.take()
  //     if (val === Channel.CLOSED) {
  //       return Channel.CLOSED // [Channel.CLOSED].concat(await childGo)
  //     }
  //
  //     await asycFn(val, concurrent)
  //   }
  // } catch (e) {
  //   console.log(e)
  // }
  //
  // await childGo
  // return Channel.CLOSED // [Channel.CLOSED].concat(await childGo)
}
