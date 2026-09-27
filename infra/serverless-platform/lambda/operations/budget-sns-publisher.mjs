import { budgetDestination } from "./budgets.mjs";

// Lazy load so an unconfigured installation remains usable. A configured
// installation without the pinned SDK fails activation; no fake adapter.
export async function createBudgetSnsPublisher({ destination = null, credentials, requestHandler } = {}) {
  if (destination === null) return null;
  if (!budgetDestination(destination) || destination.split(":")[5].length > 256
    || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(destination.split(":")[3])
    || (destination.split(":")[1] === "aws-cn") !== destination.split(":")[3].startsWith("cn-")
    || (destination.split(":")[1] === "aws-us-gov") !== destination.split(":")[3].startsWith("us-gov-")) {
    throw new TypeError("Budget SNS destination is invalid.");
  }
  const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
  const client = new SNSClient({
    region: destination.split(":")[3], maxAttempts: 1,
    ...(credentials ? { credentials } : {}),
    ...(requestHandler ? { requestHandler } : {}),
  });
  return Object.freeze({
    async publish({ destination: requested, idempotencyKey, message, abortSignal } = {}) {
      if (requested !== destination) throw new TypeError("Budget SNS destination mismatch.");
      if (typeof idempotencyKey !== "string" || !/^[a-f0-9]{64}$/.test(idempotencyKey)
        || typeof message !== "string" || Buffer.byteLength(message) > 65_536) {
        throw new TypeError("Budget SNS payload is invalid.");
      }
      let payload;
      try { payload = JSON.parse(message); } catch { throw new TypeError("Budget SNS payload is invalid."); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Budget SNS payload is invalid.");
      abortSignal?.throwIfAborted();
      const result = await client.send(new PublishCommand({
        TopicArn: destination, Message: message,
        ...(destination.endsWith(".fifo")
          ? { MessageGroupId: "project-budget", MessageDeduplicationId: idempotencyKey } : {}),
      }), abortSignal ? { abortSignal } : undefined);
      // Delivery validates the acknowledgement; never synthesize an ID.
      return { MessageId: result.MessageId };
    },
  });
}
