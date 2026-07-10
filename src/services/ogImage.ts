import { readFileSync } from "fs";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const WIDTH = 1200;
const HEIGHT = 630;

// Approved "warm cream" palette (spec: 2026-07-10-og-share-cards-design.md)
const BG_GRADIENT = "linear-gradient(135deg, #FAF8F6 0%, #F3EFE9 100%)";
const TERRACOTTA = "#C2703E";
const HEADLINE_COLOR = "#2A2420";
const SUBLINE_COLOR = "#7A6F62";
const MONOGRAM_BG = "#F9E1D0";

type SatoriFont = {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
};

let fonts: SatoriFont[] | null = null;

/** Fonts ship in @fontsource packages (woff — satori-compatible); loaded once. */
function loadFonts(): SatoriFont[] {
  if (!fonts) {
    fonts = [
      {
        name: "Vollkorn",
        data: readFileSync(
          require.resolve("@fontsource/vollkorn/files/vollkorn-latin-700-normal.woff"),
        ),
        weight: 700,
        style: "normal",
      },
      {
        name: "Inter",
        data: readFileSync(
          require.resolve("@fontsource/inter/files/inter-latin-400-normal.woff"),
        ),
        weight: 400,
        style: "normal",
      },
      {
        name: "Inter",
        data: readFileSync(
          require.resolve("@fontsource/inter/files/inter-latin-700-normal.woff"),
        ),
        weight: 700,
        style: "normal",
      },
    ];
  }
  return fonts;
}

// Satori element helper — plain object trees, no JSX.
function el(type: string, style: Record<string, unknown>, children?: unknown) {
  return {
    type,
    props: { style, ...(children !== undefined ? { children } : {}) },
  };
}

function headlineFontSize(name: string): number {
  if (name.length <= 20) return 68;
  if (name.length <= 40) return 56;
  return 48;
}

function avatarNode(avatarDataUri: string | undefined, displayName: string) {
  const ring = `10px solid ${TERRACOTTA}`;
  if (avatarDataUri) {
    return {
      type: "img",
      props: {
        src: avatarDataUri,
        width: 300,
        height: 300,
        style: {
          width: 300,
          height: 300,
          borderRadius: 150,
          border: ring,
          objectFit: "cover",
          flexShrink: 0,
        },
      },
    };
  }
  // Monogram fallback: first letter in a terracotta-ringed circle.
  const letter = (displayName.trim()[0] || "?").toUpperCase();
  return el(
    "div",
    {
      width: 300,
      height: 300,
      borderRadius: 150,
      border: ring,
      backgroundColor: MONOGRAM_BG,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "Vollkorn",
      fontWeight: 700,
      fontSize: 140,
      color: TERRACOTTA,
      flexShrink: 0,
    },
    letter,
  );
}

async function renderCard(opts: {
  headline: string;
  headlineFontSize: number;
  subline: string;
  avatar: unknown;
}): Promise<Buffer> {
  const tree = el(
    "div",
    {
      width: WIDTH,
      height: HEIGHT,
      display: "flex",
      alignItems: "center",
      gap: 72,
      padding: "0 96px",
      backgroundImage: BG_GRADIENT,
      position: "relative",
    },
    [
      opts.avatar,
      // Fixed width so the headline wraps/clamps inside the padded content
      // area: 1200 − 2×96 padding − 300 avatar − 72 gap = 636.
      el("div", { display: "flex", flexDirection: "column", width: 636 }, [
        el(
          "div",
          {
            fontFamily: "Inter",
            fontWeight: 700,
            fontSize: 26,
            letterSpacing: "0.18em",
            color: TERRACOTTA,
            marginBottom: 20,
          },
          "OPEN SOCIAL",
        ),
        el(
          "div",
          {
            fontFamily: "Vollkorn",
            fontWeight: 700,
            fontSize: opts.headlineFontSize,
            color: HEADLINE_COLOR,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            // Satori only clamps block elements with a single string child.
            display: "block",
            lineClamp: 2,
          },
          opts.headline,
        ),
        el(
          "div",
          {
            fontFamily: "Inter",
            fontWeight: 400,
            fontSize: 38,
            color: SUBLINE_COLOR,
            marginTop: 20,
          },
          opts.subline,
        ),
      ]),
      // Terracotta accent bar along the bottom edge.
      el("div", {
        position: "absolute",
        left: 0,
        bottom: 0,
        width: WIDTH,
        height: 16,
        backgroundColor: TERRACOTTA,
      }),
    ],
  );

  const svg = await satori(tree as any, {
    width: WIDTH,
    height: HEIGHT,
    fonts: loadFonts(),
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } });
  return resvg.render().asPng();
}

/** The per-community share card: avatar + "Join {name}" + "on Open Social". */
export async function renderCommunityCard(opts: {
  displayName: string;
  avatarDataUri?: string;
}): Promise<Buffer> {
  return renderCard({
    headline: `Join ${opts.displayName}`,
    headlineFontSize: headlineFontSize(opts.displayName),
    subline: "on Open Social",
    avatar: avatarNode(opts.avatarDataUri, opts.displayName),
  });
}

/** Generic fallback card for the web app's static og:image tag. */
export async function renderDefaultCard(): Promise<Buffer> {
  return renderCard({
    headline: "Open Social",
    headlineFontSize: 68,
    subline: "Communities for the open social web",
    avatar: avatarNode(undefined, "Open Social"),
  });
}
