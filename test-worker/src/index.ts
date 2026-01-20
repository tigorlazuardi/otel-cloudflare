import { instrument, getLogger, withTrace, withAttrs } from "../../src/index.js";

interface Env {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_SERVICE_NAME?: string;
}

export default instrument<Env>(
  {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const logger = getLogger();

      logger.info("request received", {
        method: request.method,
        path: url.pathname,
      });

      if (url.pathname === "/") {
        return withAttrs({ handler: "home" }, () => {
          logger.info("handling home route");
          return new Response("Hello from otel-cloudflare test worker!");
        });
      }

      if (url.pathname === "/trace") {
        return await withTrace(async (span) => {
          span.setAttribute("custom.attr", "test-value");

          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 100));

          logger.info("trace endpoint called");

          return new Response(
            JSON.stringify({
              message: "Trace created!",
              traceId: span.spanContext().traceId,
            }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
        }, { name: "handleTrace" });
      }

      if (url.pathname === "/log") {
        logger.trace("trace level log");
        logger.debug("debug level log");
        logger.info("info level log");
        logger.warn("warn level log");
        logger.error("error level log");

        return new Response("Logs sent!");
      }

      if (url.pathname === "/error") {
        logger.error("intentional error for testing", { errorCode: "TEST_ERROR" });
        throw new Error("Test error!");
      }

      logger.warn("not found", { path: url.pathname });
      return new Response("Not Found", { status: 404 });
    },
  },
  (env) => ({
    serviceName: env.OTEL_SERVICE_NAME ?? "otel-test-worker",
  }),
);
