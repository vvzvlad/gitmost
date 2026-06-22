// Pure FIFO helpers for the AI-chat "send while the agent is busy" queue.
// Kept side-effect free so they can be unit-tested without React.

export interface QueuedMessage {
  id: string;
  text: string;
}

/** Append a message to the end of the queue (returns a new array). */
export function enqueueMessage(
  queue: QueuedMessage[],
  message: QueuedMessage,
): QueuedMessage[] {
  return [...queue, message];
}

/** Split the queue into its first item (`head`) and the remainder (`rest`).
 *  `head` is null when the queue is empty. Does not mutate the input. */
export function dequeue(queue: QueuedMessage[]): {
  head: QueuedMessage | null;
  rest: QueuedMessage[];
} {
  if (queue.length === 0) return { head: null, rest: [] };
  const [head, ...rest] = queue;
  return { head, rest };
}

/** Remove the queued message with the given id (returns a new array). */
export function removeQueuedById(
  queue: QueuedMessage[],
  id: string,
): QueuedMessage[] {
  return queue.filter((m) => m.id !== id);
}
