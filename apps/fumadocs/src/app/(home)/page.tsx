"use client";

import { useGSAP } from "@gsap/react";
import {
  AddCircleIcon,
  ArrowRight02Icon,
  ArrowUpRight01Icon,
  CheckmarkBadge02Icon,
  Copy01Icon,
  Delete02Icon,
  GitForkIcon,
  SourceCodeIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { DomainLogo } from "@/components/domain-logo";
import { ProviderLogo } from "@/components/provider-logo";
import { track } from "@/lib/analytics";

gsap.registerPlugin(useGSAP, ScrollTrigger);

const providers = [
  { id: "vercel", name: "Vercel", href: "/docs/providers/vercel" },
  { id: "cloudflare", name: "Cloudflare for SaaS", href: "/docs/providers/cloudflare" },
  { id: "railway", name: "Railway", href: "/docs/providers/railway" },
  { id: "render", name: "Render", href: "/docs/providers/render" },
  { id: "netlify", name: "Netlify", href: "/docs/providers/netlify" },
] as const;

const providerLoop = Array.from({ length: 4 }, () => providers).flat();

const manifestoLead = "Add the hostname. Return the exact DNS.";
const manifestoClose = "Track it until the domain is ready.";

function HeroArtwork() {
  return (
    <div className="hero-art" aria-hidden="true">
      <Image
        src="/images/domain-thread-hero-transparent.png"
        alt=""
        width={1942}
        height={809}
        priority
        unoptimized
        sizes="100vw"
      />
    </div>
  );
}

function CodeExample() {
  return (
    <pre aria-label="TypeScript Domain SDK example">
      <code>
        <span className="code-line">
          <span className="syntax-keyword">import</span> {"{ "}
          <span className="syntax-function">createDomainClient</span>
          {" } "}
          <span className="syntax-keyword">from</span>{" "}
          <span className="syntax-string">&quot;@opencoredev/domain-sdk&quot;</span>
          {"\n"}
        </span>
        <span className="code-line">
          <span className="syntax-keyword">import</span> {"{ "}
          <span className="syntax-function">vercel</span>
          {" } "}
          <span className="syntax-keyword">from</span>{" "}
          <span className="syntax-string">&quot;@opencoredev/domain-sdk/vercel&quot;</span>
          {"\n"}
        </span>
        <span className="code-line">{"\n"}</span>
        <span className="code-line">
          <span className="syntax-keyword">const</span> domains ={" "}
          <span className="syntax-function">createDomainClient</span>
          {"({\n"}
        </span>
        <span className="code-line">
          {"  "}provider: <span className="syntax-function">vercel</span>
          {"({\n"}
        </span>
        <span className="code-line">
          {"    "}token: process.env.<span className="syntax-property">VERCEL_TOKEN</span>!,
          {"\n"}
        </span>
        <span className="code-line">
          {"    "}projectId: process.env.
          <span className="syntax-property">VERCEL_PROJECT_ID</span>!,
          {"\n"}
        </span>
        <span className="code-line">{"  }),\n"}</span>
        <span className="code-line">{"})\n"}</span>
        <span className="code-line">{"\n"}</span>
        <span className="code-line">
          <span className="syntax-keyword">const</span> domain ={" "}
          <span className="syntax-keyword">await</span> domains.
          <span className="syntax-function">add</span>(
          <span className="syntax-string">&quot;app.customer.com&quot;</span>){"\n"}
        </span>
      </code>
    </pre>
  );
}

const trackedSections = [
  ["editorial-hero", "hero"],
  ["manifesto-section", "manifesto"],
  ["capability-section", "capabilities"],
  ["architecture-section", "architecture"],
  ["lifecycle-section", "lifecycle"],
  ["closing-section", "closing"],
] as const;

export default function HomePage() {
  const root = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const seen = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const name = trackedSections.find(([className]) =>
            entry.target.classList.contains(className),
          )?.[1];
          if (!name || seen.has(name)) continue;
          seen.add(name);
          track("home_section_viewed", { section: name });
        }
      },
      { threshold: 0.4 },
    );
    for (const [className] of trackedSections) {
      const element = root.current?.querySelector(`.${className}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      const intro = gsap.timeline({ defaults: { ease: "power3.out" } });
      intro
        .from(".home-nav", { y: -18, opacity: 0, duration: 0.7 })
        .from(".hero-reveal", { y: 38, opacity: 0, duration: 0.9, stagger: 0.1 }, "-=0.35")
        .from(".hero-art", { scale: 0.9, opacity: 0, y: 36, duration: 1.25 }, "-=0.55");

      const words = gsap.utils.toArray<HTMLElement>(".manifesto-word");
      gsap.set(words, { opacity: 0.14 });
      const wordTimeline = gsap.timeline({
        scrollTrigger: {
          trigger: ".manifesto-copy",
          start: "top 78%",
          end: "bottom 48%",
          scrub: 0.8,
        },
      });
      words.forEach((word, index) => {
        wordTimeline.to(word, { opacity: 1, duration: 0.16 }, index * 0.07);
      });

      gsap.fromTo(
        ".architecture-visual",
        { scale: 0.82, opacity: 0.28 },
        {
          scale: 1,
          opacity: 1,
          ease: "none",
          scrollTrigger: {
            trigger: ".architecture-section",
            start: "top 82%",
            end: "center 48%",
            scrub: 1,
          },
        },
      );
    },
    { scope: root },
  );

  async function copyInstall() {
    await navigator.clipboard.writeText("bun add @opencoredev/domain-sdk");
    track("install_command_copied", {
      command: "bun add @opencoredev/domain-sdk",
      location: "home_hero",
    });
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <main ref={root} className="domain-home">
      <nav className="home-nav" aria-label="Main navigation">
        <Link className="home-brand" href="/">
          <span className="brand-mark">
            <DomainLogo />
          </span>
          <span>Domain SDK</span>
        </Link>
        <div className="home-nav-links">
          <Link href="/docs">Docs</Link>
          <Link href="/docs/providers">Providers</Link>
          <Link href="/docs/installation">Installation</Link>
        </div>
        <div className="nav-actions">
          <Link
            className="nav-source"
            href="https://github.com/opencoredev/domain-sdk"
            onClick={() => track("cta_clicked", { cta: "github", location: "home_nav" })}
          >
            GitHub
          </Link>
          <Link
            className="nav-cta"
            href="/docs/installation"
            onClick={() => track("cta_clicked", { cta: "get_started", location: "home_nav" })}
          >
            Get started
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={15} strokeWidth={1.8} />
          </Link>
        </div>
      </nav>

      <section className="editorial-hero">
        <h1 className="hero-reveal">
          <span>Custom domains,</span>
          <span>handled.</span>
        </h1>
        <p className="hero-reveal hero-subtitle">
          Add, verify, monitor, and remove customer domains with one TypeScript API.
        </p>
        <div className="hero-reveal hero-actions">
          <Link
            className="button-light"
            href="/docs/installation"
            onClick={() => track("cta_clicked", { cta: "install_domain_sdk", location: "home_hero" })}
          >
            Install Domain SDK
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={1.8} />
          </Link>
          <button className="install-command" type="button" onClick={copyInstall}>
            <span>$</span>
            <code>bun add @opencoredev/domain-sdk</code>
            <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={15} strokeWidth={1.7} />
          </button>
        </div>
        <HeroArtwork />
        <div className="provider-marquee" aria-label="Supported providers">
          <ul className="provider-track">
            {providerLoop.map((provider, index) => (
              <li
                className={`provider-item provider-${provider.id}`}
                key={`${provider.id}-${index}`}
                aria-hidden={index >= providers.length}
              >
                <Link
                  href={provider.href}
                  tabIndex={index >= providers.length ? -1 : undefined}
                  onClick={() =>
                    track("provider_link_clicked", { provider: provider.id, location: "home_marquee" })
                  }
                >
                  <ProviderLogo provider={provider.id} />
                  <span>{provider.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="manifesto-section">
        <p className="manifesto-copy">
          {manifestoLead.split(" ").map((word, index) => (
            <span className="manifesto-word" key={`${word}-${index}`}>
              {word}{" "}
            </span>
          ))}
          {manifestoClose.split(" ").map((word, index) => (
            <span className="manifesto-word" key={`${word}-close-${index}`}>
              {word}{" "}
            </span>
          ))}
        </p>
      </section>

      <section className="capability-section">
        <div className="section-heading">
          <h2>Everything your custom-domain flow needs. One API.</h2>
          <p>
            Domain SDK keeps platform-specific APIs at the edge of your system and returns a model
            your product can render directly.
          </p>
        </div>
        <div className="capability-grid">
          <article className="capability-card capability-code">
            <div className="code-window-bar">
              <span>domains.ts</span>
            </div>
            <CodeExample />
          </article>
          <article className="capability-card status-card">
            <div className="status-ledger" aria-hidden="true">
              <div className="status-ledger-head">
                <code>app.customer.com</code>
                <span>ready</span>
              </div>
              <div className="status-check">
                <span>Routing</span>
                <b>Configured</b>
              </div>
              <div className="status-check">
                <span>Ownership</span>
                <b>Verified</b>
              </div>
              <div className="status-check">
                <span>TLS certificate</span>
                <b>Issued</b>
              </div>
            </div>
            <h3>Honest readiness</h3>
            <p>
              Routing, ownership, and certificate state stay separate until the provider confirms
              the domain is ready.
            </p>
          </article>
          <article className="capability-card adapter-card">
            <h3>
              Change the adapter.
              <br />
              Keep the workflow.
            </h3>
            <div className="adapter-swap">
              <code>
                <span className="syntax-function">vercel</span>
                <span className="syntax-punctuation">()</span>
              </code>
              <HugeiconsIcon icon={ArrowRight02Icon} size={19} strokeWidth={1.6} />
              <code>
                <span className="syntax-function">railway</span>
                <span className="syntax-punctuation">()</span>
              </code>
            </div>
          </article>
          <article className="capability-card dns-card">
            <div className="dns-card-head">
              <h3>DNS instructions your UI can trust</h3>
              <Link
                href="/docs/concepts/dns-records"
                onClick={() => track("cta_clicked", { cta: "explore_dns_model", location: "home_capabilities" })}
              >
                Explore the model
                <HugeiconsIcon icon={ArrowUpRight01Icon} size={15} strokeWidth={1.8} />
              </Link>
            </div>
            <div className="dns-row">
              <b>TXT</b>
              <code>_vercel.app.customer.com</code>
              <span>ownership</span>
            </div>
            <div className="dns-row">
              <b>CNAME</b>
              <code>app.customer.com</code>
              <span>routing</span>
            </div>
            <div className="dns-row">
              <b>TXT</b>
              <code>_acme-challenge.app.customer.com</code>
              <span>certificate</span>
            </div>
          </article>
        </div>
      </section>

      <section className="architecture-section">
        <div className="architecture-copy">
          <h2>Your complete domain workflow, already handled.</h2>
          <p>
            Your application owns tenant authorization and state. Domain SDK talks to the configured
            platform. The provider remains the source of truth.
          </p>
          <Link
            href="/docs/providers"
            onClick={() => track("cta_clicked", { cta: "compare_providers", location: "home_architecture" })}
          >
            Compare providers
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={1.8} />
          </Link>
        </div>
        <div className="architecture-visual" aria-label="Domain SDK architecture diagram">
          <div className="architecture-node architecture-app">
            <HugeiconsIcon icon={SourceCodeIcon} size={23} strokeWidth={1.5} />
            <div>
              <span>Your application</span>
              <small>tenant rules + database</small>
            </div>
          </div>
          <div className="architecture-arrow" aria-hidden="true">
            <i />
            <HugeiconsIcon icon={ArrowRight02Icon} size={18} strokeWidth={1.4} />
          </div>
          <div className="architecture-node architecture-sdk">
            <span className="brand-mark" aria-hidden="true">
              <DomainLogo />
            </span>
            <div>
              <span>Domain SDK</span>
              <small>one typed contract</small>
            </div>
          </div>
          <div className="architecture-arrow" aria-hidden="true">
            <i />
            <HugeiconsIcon icon={ArrowRight02Icon} size={18} strokeWidth={1.4} />
          </div>
          <div className="architecture-providers">
            {providers.map((provider) => (
              <Link
                href={provider.href}
                key={provider.id}
                onClick={() =>
                  track("provider_link_clicked", { provider: provider.id, location: "home_architecture" })
                }
              >
                <ProviderLogo provider={provider.id} />
                <span>{provider.name}</span>
                <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={1.5} />
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="lifecycle-section">
        <div className="section-heading compact">
          <h2>Everything needed for the lifecycle. Nothing pretending to be magic.</h2>
        </div>
        <div className="lifecycle-accordion">
          <article>
            <span>Add</span>
            <div className="lifecycle-preview preview-add" aria-hidden="true">
              <div className="preview-field">
                <HugeiconsIcon icon={AddCircleIcon} size={18} strokeWidth={1.4} />
                <code>app.customer.com</code>
                <b>added</b>
              </div>
              <div className="preview-event">
                <code>POST /domains</code>
                <span>201</span>
              </div>
            </div>
            <div>
              <h3>Attach a hostname</h3>
              <p>
                Validate once, add it to the configured resource, and safely handle repeat requests.
              </p>
            </div>
          </article>
          <article>
            <span>Configure</span>
            <div className="lifecycle-preview preview-dns" aria-hidden="true">
              <div>
                <b>CNAME</b>
                <code>cname.vercel-dns.com</code>
              </div>
              <div>
                <b>TXT</b>
                <code>vc-domain-verify=...</code>
              </div>
            </div>
            <div>
              <h3>Return exact DNS</h3>
              <p>
                Give customers routing, ownership, and certificate records with clear purposes and
                status.
              </p>
            </div>
          </article>
          <article>
            <span>Activate</span>
            <div className="lifecycle-preview preview-activate" aria-hidden="true">
              <div className="preview-progress">
                <i />
                <i />
                <i />
              </div>
              <div className="preview-statuses">
                <span>DNS</span>
                <span>Verify</span>
                <span>Active</span>
              </div>
              <div className="preview-ready">
                <HugeiconsIcon icon={CheckmarkBadge02Icon} size={17} strokeWidth={1.4} />
                Ready to serve
              </div>
            </div>
            <div>
              <h3>Wait for the provider</h3>
              <p>
                Poll sequentially with cancellation and backoff. Mark active only when the provider
                does.
              </p>
            </div>
          </article>
          <article>
            <span>Remove</span>
            <div className="lifecycle-preview preview-remove" aria-hidden="true">
              <div className="preview-field">
                <HugeiconsIcon icon={Delete02Icon} size={18} strokeWidth={1.4} />
                <code>app.customer.com</code>
                <b>removed</b>
              </div>
              <div className="preview-event">
                <code>DELETE /domains</code>
                <span>204</span>
              </div>
            </div>
            <div>
              <h3>Disconnect safely</h3>
              <p>
                Remove only from the configured provider scope and treat an already-absent hostname
                as success.
              </p>
            </div>
          </article>
        </div>
      </section>

      <section className="closing-section">
        <p>Add the hostname. Show the records. Wait for ready.</p>
        <h2>Ship custom domains without rebuilding the workflow.</h2>
        <div className="closing-actions">
          <Link
            className="button-dark"
            href="/docs/installation"
            onClick={() => track("cta_clicked", { cta: "start_building", location: "home_closing" })}
          >
            Start building
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={1.8} />
          </Link>
          <Link
            className="button-outline-dark"
            href="https://github.com/opencoredev/domain-sdk"
            onClick={() => track("cta_clicked", { cta: "view_source", location: "home_closing" })}
          >
            <HugeiconsIcon icon={GitForkIcon} size={15} strokeWidth={1.8} /> View source
          </Link>
        </div>
      </section>

      <footer className="home-footer">
        <Link className="home-brand" href="/">
          <span className="brand-mark">
            <DomainLogo />
          </span>
          <span>Domain SDK</span>
        </Link>
        <div>
          <Link href="/docs">Documentation</Link>
          <Link href="/docs/project/contributing">Contributing</Link>
          <Link href="https://github.com/sponsors/opencoredev">Sponsor</Link>
        </div>
      </footer>
    </main>
  );
}
