import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPersonPresence } from '../src/detection/person-presence.js'

const person = (score = 0.9) => ({ class: 'person', score, bbox: [0, 0, 100, 200] })
const confirm = (gate, time = 0) => {
  gate.update([person()], time)
  return gate.update([person()], time + 1000)
}
const clear = (gate, time) => {
  gate.update([], time)
  gate.update([], time + 1000)
  return gate.update([], time + 2000)
}

describe('person presence confirmation and notifications', () => {
  it('requires two consecutive qualifying observations and ignores noisy classifications', () => {
    const gate = createPersonPresence()
    assert.deepEqual(gate.update([person(0.6)], 0), { present: false, count: 1, score: 0.6, notify: false })
    assert.equal(gate.update([{ class: 'dog', score: 0.99 }, person(0.59)], 1000).present, false)
    assert.equal(gate.update([person()], 2000).notify, false)
    assert.deepEqual(gate.update([person(0.7), person(0.95)], 3000),
      { present: true, count: 2, score: 0.95, notify: true })
  })

  it('does not count malformed or out-of-range confidence values', () => {
    const gate = createPersonPresence()
    const invalid = [person(NaN), person(Infinity), person(-0.2), person(1.01), person('0.9'), null]
    assert.deepEqual(gate.update(invalid, 0), { present: false, count: 0, score: 0, notify: false })
    assert.equal(gate.update([person(1)], 1000).notify, false)
    assert.equal(gate.update([person(1)], 2000).notify, true)
  })

  it('suppresses repeated alerts while someone remains, even past the cooldown', () => {
    const gate = createPersonPresence()
    assert.equal(confirm(gate).notify, true)
    for (const time of [2000, 15000, 16000, 60000]) {
      assert.deepEqual(gate.update([person()], time), { present: true, count: 1, score: 0.9, notify: false })
    }
  })

  it('tolerates brief missed detections and rearms only after three consecutive negatives', () => {
    const gate = createPersonPresence()
    confirm(gate)
    assert.deepEqual(gate.update([], 2000), { present: true, count: 0, score: 0, notify: false })
    assert.equal(gate.update([], 3000).present, true)
    assert.equal(gate.update([person()], 4000).notify, false)
    assert.equal(gate.update([], 5000).present, true)
    assert.equal(gate.update([], 6000).present, true)
    assert.equal(gate.update([], 7000).present, false)
    assert.equal(confirm(gate, 15000).notify, true)
  })

  it('suppresses an entry inside cooldown without sending a delayed alert for that episode', () => {
    const gate = createPersonPresence()
    assert.equal(confirm(gate).notify, true)
    clear(gate, 2000)
    assert.deepEqual(confirm(gate, 5000), { present: true, count: 1, score: 0.9, notify: false })
    assert.equal(gate.update([person()], 60000).notify, false)
    clear(gate, 61000)
    assert.equal(confirm(gate, 64000).notify, true)
  })

  it('resets partial observations and presence while preserving notification cooldown', () => {
    const gate = createPersonPresence()
    gate.update([person()], 0)
    gate.reset()
    assert.equal(gate.update([person()], 1000).notify, false)
    assert.equal(gate.update([person()], 2000).notify, true)
    gate.reset()
    assert.equal(gate.update([], 3000).present, false)
    assert.equal(confirm(gate, 4000).notify, false)
    gate.reset()
    assert.equal(confirm(gate, 16000).notify, true)
  })

  it('keeps cameras independent', () => {
    const first = createPersonPresence()
    const second = createPersonPresence()
    first.update([person()], 0)
    assert.equal(second.update([person()], 1000).notify, false)
    assert.equal(first.update([person()], 1000).notify, true)
    assert.equal(second.update([person()], 2000).notify, true)
    clear(first, 3000)
    assert.equal(second.update([], 6000).present, true)
  })

  it('rejects invalid observation timestamps without advancing confirmation state', () => {
    const gate = createPersonPresence()
    for (const time of [NaN, Infinity, -Infinity, undefined]) {
      assert.throws(() => gate.update([person()], time), /timestamp must be finite/)
    }
    assert.equal(gate.update([person()], 0).notify, false)
    assert.equal(gate.update([person()], 1000).notify, true)
  })
})
