import { BRAND } from "../../lib/brand";

type BrandMarkProps = {
  className?: string;
  inverse?: boolean;
  label?: string;
  showWordmark?: boolean;
  size?: number;
  subtitle?: string;
};

export default function BrandMark({
  className = "",
  inverse = false,
  label = BRAND.name,
  showWordmark = false,
  size = 32,
  subtitle,
}: BrandMarkProps) {
  return (
    <span
      className={`brand-lockup${inverse ? " brand-lockup--inverse" : ""}${className ? ` ${className}` : ""}`}
      aria-label={showWordmark ? undefined : label}
      role={showWordmark ? undefined : "img"}
    >
      <svg
        className="brand-mark"
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M7 7H11.5C15.5 7 16 12 21.5 12" />
        <path d="M7 16H21.5" />
        <path d="M7 25H11.5C15.5 25 16 20 21.5 20" />
        <path d="M22 5V27" />
        <circle cx="5" cy="7" r="2" />
        <circle cx="5" cy="16" r="2" />
        <circle cx="5" cy="25" r="2" />
      </svg>
      {showWordmark ? (
        <span className="brand-lockup__copy">
          <strong>{label}</strong>
          {subtitle ? <small>{subtitle}</small> : null}
        </span>
      ) : null}
    </span>
  );
}
