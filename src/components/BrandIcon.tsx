"use client";

type BrandIconName =
  | "graphlit"
  | "openai"
  | "mastra"
  | "claude"
  | "google";

type BrandIconProps = {
  name: BrandIconName;
  className?: string;
  alt?: string;
};

const BRANDFETCH_CLIENT_ID = "1idAWDcs4aaUcfq09x5";

const BRAND_CONFIGS: Record<
  Exclude<BrandIconName, "graphlit" | "mastra">,
  { domain: string; type: "icon" | "symbol" | "logo" }
> = {
  openai: { domain: "openai.com", type: "icon" },
  claude: { domain: "anthropic.com", type: "icon" },
  google: { domain: "google.com", type: "symbol" },
};

function brandfetchUrl(
  name: Exclude<BrandIconName, "graphlit" | "mastra">,
): string {
  const config = BRAND_CONFIGS[name];
  const params = new URLSearchParams({ c: BRANDFETCH_CLIENT_ID });

  return `https://cdn.brandfetch.io/${config.domain}/w/128/h/128/${config.type}?${params.toString()}`;
}

function iconSrc(name: BrandIconName): string {
  switch (name) {
    case "graphlit":
      return "/images/graphlit-logo.svg";
    case "mastra":
      return "/images/mastra-logo.svg";
    default:
      return brandfetchUrl(name);
  }
}

export function BrandIcon({
  name,
  className = "h-4 w-4",
  alt,
}: BrandIconProps) {
  const src = iconSrc(name);

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? `${name} icon`}
        className="max-h-full max-w-full object-contain"
      />
    </span>
  );
}
