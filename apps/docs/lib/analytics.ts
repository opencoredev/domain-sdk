// Custom homepage PostHog events, kept to the names the Fumadocs landing page
// sent so existing homepage funnel insights keep working. Blume's posthog()
// adapter loads posthog-js and records pageviews/autocapture; these calls are
// no-ops when analytics is off (dev builds, or no PUBLIC_POSTHOG_KEY).

type EventProperties = Record<string, string | number | boolean | null | undefined>;

export type AnalyticsEvent =
  | "cta_clicked"
  | "install_command_copied"
  | "provider_link_clicked"
  | "home_section_viewed";

interface PostHogCapture {
  capture: (event: string, properties?: EventProperties) => void;
}

const hasCapture = (value: unknown): value is PostHogCapture =>
  typeof value === "object" &&
  value !== null &&
  "capture" in value &&
  typeof value.capture === "function";

export function track(event: AnalyticsEvent, properties?: EventProperties): void {
  const posthog: unknown = Reflect.get(window, "posthog");
  if (hasCapture(posthog)) posthog.capture(event, properties);
}
