import { Construct } from "constructs";

/** Demo deployments share regional capacity; dedicated reservations are opt-in. */
export function lambdaReservedConcurrency(scope: Construct, reserved: number): number | undefined {
  const mode = scope.node.tryGetContext("lambdaConcurrencyMode") ?? "shared";
  if (mode !== "shared" && mode !== "reserved") {
    throw new Error("lambdaConcurrencyMode must be shared or reserved.");
  }
  return mode === "reserved" ? reserved : undefined;
}
