/* oxlint-disable next/no-img-element -- ImageResponse renders with Satori, not the browser. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

export const socialImageAlt =
  "Domain SDK — Custom domains, handled. Add, verify, monitor, and remove domains with one TypeScript API.";

export const socialImageSize = {
  width: 1200,
  height: 630,
};

export const socialImageContentType = "image/png";

export async function createSocialImage() {
  const [geist, instrumentSerif, background] = await Promise.all([
    readFile(join(process.cwd(), "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf")),
    readFile(join(process.cwd(), "public/fonts/InstrumentSerif-Regular.ttf")),
    readFile(join(process.cwd(), "public/images/domain-sdk-og-background-v2.png"), "base64"),
  ]);

  const backgroundSrc = `data:image/png;base64,${background}`;

  return new ImageResponse(
    <div
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        justifyContent: "center",
        background: "#050504",
        color: "#f4ede2",
      }}
    >
      <img
        src={backgroundSrc}
        alt=""
        width={1200}
        height={630}
        style={{
          position: "absolute",
          width: 1200,
          height: 630,
          objectFit: "cover",
          objectPosition: "center center",
        }}
      />

      <div
        style={{
          position: "absolute",
          top: 78,
          display: "flex",
          width: 1080,
          alignItems: "center",
          flexDirection: "column",
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexDirection: "column",
            fontFamily: "Instrument Serif",
            fontSize: 76,
            fontWeight: 400,
            letterSpacing: "-0.035em",
            lineHeight: 0.88,
            textShadow: "0 3px 28px rgba(0, 0, 0, 0.55)",
          }}
        >
          <span>Custom domains,</span>
          <span>handled.</span>
        </div>
        <span
          style={{
            marginTop: 25,
            color: "#d8d2c9",
            fontFamily: "Geist",
            fontSize: 22,
            letterSpacing: "-0.025em",
            textShadow: "0 2px 20px rgba(0, 0, 0, 0.8)",
          }}
        >
          Add. Verify. Monitor. Remove.
        </span>
      </div>
    </div>,
    {
      ...socialImageSize,
      fonts: [
        {
          name: "Geist",
          data: geist,
          style: "normal",
          weight: 400,
        },
        {
          name: "Instrument Serif",
          data: instrumentSerif,
          style: "normal",
          weight: 400,
        },
      ],
    },
  );
}
