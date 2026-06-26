import { describe, it, expect } from "vitest";
import {
  enqueueMessage,
  dequeue,
  removeQueuedById,
  type QueuedMessage,
} from "./queue-helpers";

describe("enqueueMessage", () => {
  it("appends a message to the end of the queue", () => {
    const queue: QueuedMessage[] = [{ id: "a", text: "first" }];
    const next = enqueueMessage(queue, { id: "b", text: "second" });
    expect(next).toEqual([
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ]);
  });

  it("does not mutate the input queue", () => {
    const queue: QueuedMessage[] = [{ id: "a", text: "first" }];
    enqueueMessage(queue, { id: "b", text: "second" });
    expect(queue).toEqual([{ id: "a", text: "first" }]);
  });
});

describe("dequeue", () => {
  it("returns {head:null, rest:[]} for an empty queue", () => {
    expect(dequeue([])).toEqual({ head: null, rest: [] });
  });

  it("returns the first item as head and the remainder as rest", () => {
    const queue: QueuedMessage[] = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
      { id: "c", text: "third" },
    ];
    const { head, rest } = dequeue(queue);
    expect(head).toEqual({ id: "a", text: "first" });
    expect(rest).toEqual([
      { id: "b", text: "second" },
      { id: "c", text: "third" },
    ]);
  });

  it("does not mutate the input queue", () => {
    const queue: QueuedMessage[] = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ];
    dequeue(queue);
    expect(queue).toEqual([
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ]);
  });
});

describe("removeQueuedById", () => {
  it("removes the matching id and leaves the others", () => {
    const queue: QueuedMessage[] = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
      { id: "c", text: "third" },
    ];
    const next = removeQueuedById(queue, "b");
    expect(next).toEqual([
      { id: "a", text: "first" },
      { id: "c", text: "third" },
    ]);
  });

  it("returns an equivalent list when the id is not present", () => {
    const queue: QueuedMessage[] = [{ id: "a", text: "first" }];
    expect(removeQueuedById(queue, "missing")).toEqual([
      { id: "a", text: "first" },
    ]);
  });

  it("does not mutate the input queue", () => {
    const queue: QueuedMessage[] = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ];
    removeQueuedById(queue, "a");
    expect(queue).toEqual([
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ]);
  });
});

describe("FIFO order", () => {
  it("preserves order across enqueue -> dequeue", () => {
    let queue: QueuedMessage[] = [];
    queue = enqueueMessage(queue, { id: "1", text: "one" });
    queue = enqueueMessage(queue, { id: "2", text: "two" });
    queue = enqueueMessage(queue, { id: "3", text: "three" });

    const order: string[] = [];
    while (queue.length > 0) {
      const { head, rest } = dequeue(queue);
      if (head) order.push(head.text);
      queue = rest;
    }
    expect(order).toEqual(["one", "two", "three"]);
  });
});
