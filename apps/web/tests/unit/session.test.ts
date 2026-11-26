import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEYS, loadExtras, openSession, readFlag, saveExtras, writeFlag,
} from "../../src/views/dartboard2/session.ts";
import { memoryStore } from "./helpers.ts";

test("the session id and edits survive a reload", () => {
  const store = memoryStore();
  let made = 0;
  const first = openSession(store, () => `id-${++made}`);
  first.add({ seq: 3, type: "task.created", targets: ["a"] });
  first.add({ seq: 5, type: "task.attrs_set", targets: ["b"] });
  first.add({ seq: 5, type: "task.attrs_set", targets: ["b"] }); // twice is once
  const again = openSession(store, () => `id-${++made}`);
  assert.equal(again.id, "id-1");
  assert.deepEqual(again.edits().map(e => e.seq), [3, 5]);
  assert.deepEqual([...again.changed()].sort(), ["a", "b"]);
});

test("an undone edit leaves the list", () => {
  const s = openSession(memoryStore(), () => "x");
  s.add({ seq: 1, type: "t", targets: ["a"] });
  s.add({ seq: 2, type: "t", targets: ["a", "b"] });
  s.remove(2);
  assert.deepEqual(s.edits().map(e => e.seq), [1]);
  assert.deepEqual([...s.changed()], ["a"]);
});

test("under() gives the edits that touch a set of tasks, newest first", () => {
  const s = openSession(memoryStore(), () => "x");
  s.add({ seq: 1, type: "t", targets: ["a"] });
  s.add({ seq: 2, type: "t", targets: ["z"] });
  s.add({ seq: 3, type: "t", targets: ["b"] });
  assert.deepEqual(s.under(new Set(["a", "b"])).map(e => e.seq), [3, 1]);
});

test("garbage in storage starts a fresh session", () => {
  const store = memoryStore();
  store.setItem(KEYS.session, "{not json");
  const s = openSession(store, () => "fresh");
  assert.equal(s.id, "fresh");
  assert.deepEqual(s.edits(), []);
});

test("flags and the draft's presentation are kept per tab", () => {
  const store = memoryStore();
  assert.equal(readFlag(store, KEYS.showLater), false);
  writeFlag(store, KEYS.showLater, true);
  assert.equal(readFlag(store, KEYS.showLater), true);
  writeFlag(store, KEYS.showLater, false);
  assert.equal(readFlag(store, KEYS.showLater), false);
  saveExtras(store, "d1", { anchor: [["a", "k"]], pops: [], counter: 4 });
  assert.deepEqual(loadExtras(store, "d1"), { anchor: [["a", "k"]], pops: [], counter: 4 });
  assert.equal(loadExtras(store, "d2"), null);
  saveExtras(store, null);
  assert.equal(loadExtras(store, "d1"), null);
  for (const key of Object.values(KEYS)) assert.ok(key.startsWith("misty.dartboard2."));
});
