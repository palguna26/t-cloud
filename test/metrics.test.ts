import { describe, expect, it } from "vitest";
import { ServiceMetrics } from "../src/metrics.js";

describe("ServiceMetrics", () => {
  it("bounds route cardinality and exposes queue health", () => {
    const metrics = new ServiceMetrics();
    metrics.recordRequest(
      "GET",
      "/v1/admin/work-threads/77b8e5bf-5a48-4b51-b38f-57c3a83cc35f",
      200,
      12.5,
    );
    const output = metrics.render({
      pending: 2,
      failed: 1,
      dead: 0,
      oldestPendingSeconds: 4.5,
    });
    expect(output).toContain('route="/v1/admin/work-threads/:id"');
    expect(output).not.toContain("77b8e5bf");
    expect(output).toContain('termyte_jobs{state="pending"} 2');
    expect(output).toContain("termyte_oldest_pending_job_seconds 4.5");
  });
});
