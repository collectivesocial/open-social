import { readFileSync } from "fs";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const WIDTH = 1200;
const HEIGHT = 630;

// Layout geometry. TEXT_COLUMN_WIDTH is derived so the headline always
// wraps/clamps inside the padded content area — if any of these change,
// the column width follows automatically.
const PADDING_X = 96;
const AVATAR_SIZE = 300;
const COLUMN_GAP = 72;
const TEXT_COLUMN_WIDTH = WIDTH - 2 * PADDING_X - AVATAR_SIZE - COLUMN_GAP; // 636

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

export type SatoriNode = {
  type: string;
  props: Record<string, unknown> & {
    style: Record<string, unknown>;
    children?: unknown;
  };
};

// Satori element helper — plain object trees, no JSX. `extraProps` covers
// non-style attributes like an <img>'s src/width/height.
function el(
  type: string,
  style: Record<string, unknown>,
  children?: unknown,
  extraProps?: Record<string, unknown>,
): SatoriNode {
  return {
    type,
    props: {
      ...extraProps,
      style,
      ...(children !== undefined ? { children } : {}),
    },
  };
}

function headlineFontSize(name: string): number {
  if (name.length <= 20) return 68;
  if (name.length <= 40) return 56;
  return 48;
}

function avatarNode(
  avatarDataUri: string | undefined,
  displayName: string,
): SatoriNode {
  const ring = `10px solid ${TERRACOTTA}`;
  if (avatarDataUri) {
    return el(
      "img",
      {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: AVATAR_SIZE / 2,
        border: ring,
        objectFit: "cover",
        flexShrink: 0,
      },
      undefined,
      { src: avatarDataUri, width: AVATAR_SIZE, height: AVATAR_SIZE },
    );
  }
  // Monogram fallback: first letter in a terracotta-ringed circle.
  const letter = (displayName.trim()[0] || "?").toUpperCase();
  return el(
    "div",
    {
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      borderRadius: AVATAR_SIZE / 2,
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

function buildCardTree(opts: {
  headline: string;
  headlineFontSize: number;
  subline: string;
  avatar: SatoriNode;
}): SatoriNode {
  return el(
    "div",
    {
      width: WIDTH,
      height: HEIGHT,
      display: "flex",
      alignItems: "center",
      gap: COLUMN_GAP,
      padding: `0 ${PADDING_X}px`,
      backgroundImage: BG_GRADIENT,
      position: "relative",
    },
    [
      opts.avatar,
      // Fixed width so the headline wraps/clamps inside the padded content area.
      el(
        "div",
        { display: "flex", flexDirection: "column", width: TEXT_COLUMN_WIDTH },
        [
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
              // Satori only clamps block elements with a single string child;
              // lineClamp has no effect without display: "block".
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
        ],
      ),
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
}

async function renderCard(tree: SatoriNode): Promise<Buffer> {
  const svg = await satori(tree as any, {
    width: WIDTH,
    height: HEIGHT,
    fonts: loadFonts(),
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } });
  return resvg.render().asPng();
}

/**
 * The satori layout tree used by renderCommunityCard. Exported so tests can
 * structurally pin the overflow-prevention mechanism (fixed-width text column
 * + block/lineClamp headline) without decoding rendered pixels.
 */
export function buildCommunityCardTree(opts: {
  displayName: string;
  avatarDataUri?: string;
}): SatoriNode {
  return buildCardTree({
    headline: `Join ${opts.displayName}`,
    headlineFontSize: headlineFontSize(opts.displayName),
    subline: "on Open Social",
    avatar: avatarNode(opts.avatarDataUri, opts.displayName),
  });
}

/** The per-community share card: avatar + "Join {name}" + "on Open Social". */
export async function renderCommunityCard(opts: {
  displayName: string;
  avatarDataUri?: string;
}): Promise<Buffer> {
  return renderCard(buildCommunityCardTree(opts));
}

/** Generic fallback card for the web app's static og:image tag. */
export async function renderDefaultCard(): Promise<Buffer> {
  return renderCard(
    buildCardTree({
      headline: "Open Social",
      headlineFontSize: 68,
      subline: "Communities for the open social web",
      avatar: avatarNode(undefined, "Open Social"),
    }),
  );
}
