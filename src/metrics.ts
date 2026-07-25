interface RequestMetric {
  count: number;
  totalMilliseconds: number;
  maxMilliseconds: number;
}

export class ServiceMetrics {
  private readonly requests = new Map<string, RequestMetric>();

  recordRequest(method: string, path: string, status: number, milliseconds: number): void {
    const route = normalizeRoute(path);
    const key = `${method}\0${route}\0${status}`;
    const current = this.requests.get(key) ?? {
      count: 0,
      totalMilliseconds: 0,
      maxMilliseconds: 0,
    };
    current.count += 1;
    current.totalMilliseconds += milliseconds;
    current.maxMilliseconds = Math.max(current.maxMilliseconds, milliseconds);
    this.requests.set(key, current);
  }

  render(jobMetrics: {
    pending: number;
    failed: number;
    dead: number;
    oldestPendingSeconds: number;
  }): string {
    const lines = [
      "# HELP termyte_http_requests_total HTTP requests handled.",
      "# TYPE termyte_http_requests_total counter",
      "# HELP termyte_http_request_duration_milliseconds_sum Total request duration.",
      "# TYPE termyte_http_request_duration_milliseconds_sum counter",
      "# HELP termyte_http_request_duration_milliseconds_max Maximum observed request duration.",
      "# TYPE termyte_http_request_duration_milliseconds_max gauge",
    ];
    for (const [key, metric] of this.requests) {
      const [method, route, status] = key.split("\0");
      const labels = `method="${escapeLabel(method!)}",route="${escapeLabel(route!)}",status="${status}"`;
      lines.push(`termyte_http_requests_total{${labels}} ${metric.count}`);
      lines.push(
        `termyte_http_request_duration_milliseconds_sum{${labels}} ${metric.totalMilliseconds.toFixed(3)}`,
      );
      lines.push(
        `termyte_http_request_duration_milliseconds_max{${labels}} ${metric.maxMilliseconds.toFixed(3)}`,
      );
    }
    lines.push("# HELP termyte_jobs Jobs by actionable state.");
    lines.push("# TYPE termyte_jobs gauge");
    lines.push(`termyte_jobs{state="pending"} ${jobMetrics.pending}`);
    lines.push(`termyte_jobs{state="failed"} ${jobMetrics.failed}`);
    lines.push(`termyte_jobs{state="dead"} ${jobMetrics.dead}`);
    lines.push("# HELP termyte_oldest_pending_job_seconds Age of the oldest pending job.");
    lines.push("# TYPE termyte_oldest_pending_job_seconds gauge");
    lines.push(`termyte_oldest_pending_job_seconds ${jobMetrics.oldestPendingSeconds}`);
    return `${lines.join("\n")}\n`;
  }
}

function normalizeRoute(path: string): string {
  return path
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      ":id",
    )
    .replace(/\/tyt_[A-Za-z0-9_-]+/g, "/:token");
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
