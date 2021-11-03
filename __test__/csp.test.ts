import { expect } from 'chai'
import Queue from '../src/csp/buffers'
import { Channel, put, take, select, repeatTake, sleep } from '../src/csp'

describe('Channel', () => {
  describe('constructor', () => {
    it('go', async function() {
      const ch = new Channel({ name: 'ch' })
      const data = [1, 2, 3, 4, 5],
        cdata = data.slice()

      async function puts() {
        for (const val of data) {
          await put(ch, val)
        }

        await ch.close(true)
      }

      // for await( const item of ch.range()){ console.log(item) }
      const gp = repeatTake(ch, async (val, i) => console.log(ch.name, i, ' take ', val), 2)
      console.log(await Promise.all([puts(), gp]))
      expect(ch.isClosed()).to.be.true
    })

    it('无buffer的channel的put和take', async function() {
      const ch = new Channel({ name: '无buffer的ch' })
      const data = [1, 2, 3], cdata = data.slice()

      async function puts() {
        for(const val of data){
           put(ch, val).then(() => console.log(ch.name, ' put ', val))
        }

        await ch.close(true)
      }

      async function takes() {
        while (true) {
          const val = await take(ch)
          if (val === Channel.CLOSED) {
            break
          }

          expect(val).to.be.equal(cdata.shift())
          console.log(ch.name, ' take ', val)
        }
      }

      await Promise.all([puts(), takes()])
      expect(ch.isClosed()).to.be.true
    })

    it('带buffer固定大小的channel的put和take', async function() {
      const ch = new Channel({ name: '固定ch', size: 2 })
      const data = [1, 2, 3], cdata = data.slice()

      async function puts() {
        for(const val of data){
           put(ch, val).then(() => console.log(ch.name, ' put ', val))
        }

        await ch.close(true)
      }

      async function takes() {
        while (true) {
          const val = await take(ch)
          if (val === Channel.CLOSED) {
            break
          }

          expect(val).to.be.equal(cdata.shift())
          console.log(ch.name, ' take ', val)
        }
      }

      await Promise.all([puts(), takes()])
      expect(ch.isClosed()).to.be.true
    })

    it('buffer满了put直接丢弃的channel', async function() {
      const ch = new Channel({ name: '固定size模式drop的ch', size: 2, mode: 1 })
      const data = [1, 2, 3], cdata = data.slice()

      async function puts() {
        for(const val of data){
           put(ch, val) // 不await，导致buffer无法容纳，直接丢弃
        }

        await ch.close(true)
      }

      async function takes() {
        while (true) {
          const val = await take(ch)
          if (val === Channel.CLOSED) {
            break
          }

          expect(val).to.be.equal(cdata.shift())
          console.log(ch.name, ' take ', val)
        }
      }

      await Promise.all([puts(), takes()])
      expect(ch.isClosed()).to.be.true
    })

    it('buffer满了put直接删除头的channel', async function() {
      const ch = new Channel({ name: 'ch', size: 2, mode: 2 })
      const data = [1, 2, 3], cdata = data.slice(1)

      async function puts() {
        for(const val of data){
          put(ch, val) // 不await，导致buffer无法容纳，直接滑动，删除头个
        }

        await ch.close(true)
      }

      async function takes() {
        while (true) {
          const val = await take(ch)
          if (val === Channel.CLOSED) {
            break
          }

          expect(val).to.be.equal(cdata.shift())
          console.log(ch.name, ' take ', val)
        }
      }

      await Promise.all([puts(), takes()])
      expect(ch.isClosed()).to.be.true
    })

    // 太难调试了...
    it('select直到ENDED', async function() {
      const ch1 = new Channel({ name: 'ch0' })
      const ch2 = new Channel({ name: 'ch1' })

      async function puts(ch) {
        for(const val of [1, 2]){
          await put(ch, ch.name + '_' + val)
        }

        await ch.close()
      }

      async function takes() {
        while (true) {
          const [val, chan] = await select([ch1, ch2].filter(ch => !ch.isClosed()), false)
          if (val === Channel.ENDED) {
            break
          }

          console.log(chan.name, ' take ', val)
        }
      }

      await Promise.all([puts(ch1), puts(ch2), takes()])
      expect([1, 2, 3]).to.include(2)
    })

    it('select忽略closed', async function() {
      const ch1 = new Channel({ name: 'ch0' })
      const ch2 = new Channel({ name: 'ch1' })

      async function puts(ch) {
        for(const val of [1, 2]){
          await put(ch, ch.name + '_' + val)
        }

        await ch.close()
      }

      async function takes() {
        // 忽略closed
        await select([ch1, ch2], true, ([val, ch]) => {
          console.log(ch ? ch.name : 'all', ' take ', val)
        })
      }

      await Promise.all([puts(ch1), puts(ch2), takes()])
      expect([1, 2, 3]).to.include(2)
    })

    it('select不忽略closed ', async function() {
      const ch1 = new Channel({ name: 'ch0' })
      const ch2 = new Channel({ name: 'ch1' })

      async function puts(ch) {
        for(const val of [1, 2]){
          await put(ch, ch.name + '_' + val)
        }

        await ch.close()
      }

      async function takes() {
        // 不忽略closed
        await select([ch1, ch2], false, ([val, ch]) => {
          console.log(ch ? ch.name : 'all', ' take ', val)
        })
      }

      await Promise.all([puts(ch1), puts(ch2), takes()])
      expect([1, 2, 3]).to.include(2)
    })

    it('pipe 多个', async function() {
      const ch = new Channel({ name: 'ch' })
      const ch1 = new Channel({ name: 'ch1' })
      const ch2 = new Channel({ name: 'ch2' })
      ch.pipe(ch1).pipe(ch2)

      async function puts() {
        for (const val of [1, 2, 3]) {
          put(ch, val)
        }
      }

      async function takes(chan) {
        while (true) {
          const val = await take(chan)
          if (val === Channel.CLOSED) {
            break
          }

          // await sleep(120)
          console.log(chan.name, ' take ', val)
        }
      }

      setTimeout(async () => {
        put(ch, 5)
        put(ch, 6)
        await ch.close(true)
        await put(ch1, 8)
        await put(ch1, 9)
        // await ch1.close(true)
        await ch2.close(true)
      })

      await Promise.all([puts(), takes(ch2)])
      console.log('------PASS-------')
      expect([1, 2, 3]).to.include(2)
    })
  })
})