// Landing page behavior: the install-command copy button, the GSAP intro and
// scroll motion, and the PostHog events the Fumadocs landing page sent.
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import { track } from "../../lib/analytics";

gsap.registerPlugin(ScrollTrigger);

const initialized = new WeakSet<HTMLElement>();

function trackSections(root: HTMLElement): void {
  const seen = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
        const section = entry.target.dataset.section;
        if (section === undefined || seen.has(section)) continue;
        seen.add(section);
        track("home_section_viewed", { section });
      }
    },
    { threshold: 0.4 },
  );
  for (const section of root.querySelectorAll<HTMLElement>("[data-section]")) {
    observer.observe(section);
  }
}

function trackClicks(root: HTMLElement): void {
  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[data-cta], a[data-provider]");
    if (link === null) return;
    const location = link.dataset.location;
    if (link.dataset.cta !== undefined) {
      track("cta_clicked", { cta: link.dataset.cta, location });
    } else {
      track("provider_link_clicked", { provider: link.dataset.provider, location });
    }
  });
}

function setUpCopy(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>("button[data-copy]");
  if (button === null) return;
  const idle = button.querySelector<HTMLElement>("[data-copy-idle]");
  const done = button.querySelector<HTMLElement>("[data-copy-done]");
  const status = button.querySelector<HTMLElement>("[data-copy-status]");
  let timer: number | undefined;
  button.addEventListener("click", async () => {
    const command = button.dataset.copy ?? "";
    await navigator.clipboard.writeText(command);
    track("install_command_copied", { command, location: "home_hero" });
    if (idle) idle.hidden = true;
    if (done) done.hidden = false;
    if (status) status.textContent = "Copied";
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (idle) idle.hidden = false;
      if (done) done.hidden = true;
      if (status) status.textContent = "";
    }, 1400);
  });
}

function animate(root: HTMLElement): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  gsap
    .timeline({ defaults: { ease: "power3.out" } })
    .from(root.querySelector(".home-nav"), { y: -18, opacity: 0, duration: 0.7 })
    .from(
      root.querySelectorAll(".hero-reveal"),
      { y: 38, opacity: 0, duration: 0.9, stagger: 0.1 },
      "-=0.35",
    )
    .from(
      root.querySelector(".hero-art"),
      { scale: 0.9, opacity: 0, y: 36, duration: 1.25 },
      "-=0.55",
    );

  const words = gsap.utils.toArray<HTMLElement>(root.querySelectorAll(".manifesto-word"));
  gsap.set(words, { opacity: 0.14 });
  const wordTimeline = gsap.timeline({
    scrollTrigger: {
      trigger: root.querySelector(".manifesto-copy"),
      start: "top 78%",
      end: "bottom 48%",
      scrub: 0.8,
    },
  });
  words.forEach((word, index) => {
    wordTimeline.to(word, { opacity: 1, duration: 0.16 }, index * 0.07);
  });

  gsap.fromTo(
    root.querySelector(".architecture-visual"),
    { scale: 0.82, opacity: 0.28 },
    {
      scale: 1,
      opacity: 1,
      ease: "none",
      scrollTrigger: {
        trigger: root.querySelector(".architecture-section"),
        start: "top 82%",
        end: "center 48%",
        scrub: 1,
      },
    },
  );
}

/** Wires up the landing page once per page view; safe to call again. */
export function initHome(): void {
  const root = document.querySelector<HTMLElement>("[data-domain-home]");
  if (root === null || initialized.has(root)) return;
  initialized.add(root);
  trackSections(root);
  trackClicks(root);
  setUpCopy(root);
  animate(root);
}
