export enum modeWhenFull {
  fixed,
  dropping,
  sliding,
}

class Queue<T> {
  public data: T[]
  public capacity: number
  public mode: modeWhenFull

  constructor(capacity: number, mode: modeWhenFull = modeWhenFull.fixed) {
    this.data = []
    this.capacity = capacity > 0 ? capacity : 0 // 0 无限制
    this.mode = mode
  }

  public push(data: T): boolean | T {
    let ret: boolean | T = true

    if (this.isFull()) {
      if (this.mode === modeWhenFull.sliding) {
        ret = this.data.shift() // 移除最老的
      } else {
        return false // 满了忽略掉
      }
    }

    this.data.push(data)
    return ret
  }

  public shift(): any {
    if (!this.isEmpty()) {
      return this.data.shift()
    }

    return null
  }

  public unshift(...args: T[]): any {
    while (!this.isFull()) {
      this.unshift(args.shift())
    }
  }

  public splice(start: number, deleteCount: number = 0, ...items: any[]): any[] {
    return this.data.splice(start, deleteCount, ...items)
  }

  public isFull(): boolean {
    return this.capacity && this.data.length >= this.capacity
  }

  get length(): number {
    return this.data.length
  }

  public isEmpty(): boolean {
    return !this.data.length
  }

  public flush(): void {
    this.data.length = 0
  }
}

export default Queue
