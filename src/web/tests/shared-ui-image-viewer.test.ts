import assert from 'node:assert/strict'
import test from 'node:test'

import { keptImageId, openableImageId, shiftedImageId } from '../../../shared/ui/image-viewer/navigation'
import type { RoomImage } from '../../../shared/ui/image-viewer/types'

function image(id: string): RoomImage {
  return { id, href: `https://example.test/${id}.png`, name: `${id}.png`, meta: 'image/png', sender: 'EmmyMay', timestamp: '2026-11-18T04:00:00Z' }
}

const three = [image('a'), image('b'), image('c')]

test('next and previous wrap around the room images', () => {
  assert.equal(shiftedImageId(three, 'c', 1), 'a')
  assert.equal(shiftedImageId(three, 'a', -1), 'c')
  assert.equal(shiftedImageId(three, 'a', 1), 'b')
})

test('one image does not move, and a closed viewer stays closed', () => {
  assert.equal(shiftedImageId([image('a')], 'a', 1), 'a')
  assert.equal(shiftedImageId(three, null, 1), null)
})

test('only an image in the room opens', () => {
  assert.equal(openableImageId(three, 'b'), 'b')
  assert.equal(openableImageId(three, 'missing'), null)
})

test('the viewer closes when its image leaves the room', () => {
  assert.equal(keptImageId([image('a')], 'b'), null)
  assert.equal(keptImageId(three, 'b'), 'b')
  assert.equal(keptImageId(three, null), null)
})
