import type { ComponentProps } from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium leading-tight disabled:cursor-not-allowed disabled:opacity-45";

/** Primary buttons are outlined, never filled (Nocturne). */
const variants: Record<Variant, string> = {
  primary: "border-accent text-accent enabled:hover:bg-accent/12 enabled:active:bg-accent/22",
  secondary: "border-divider text-text enabled:hover:bg-text/7 enabled:active:bg-text/14",
  ghost: "border-transparent text-accent enabled:hover:bg-accent/10 enabled:active:bg-accent/18",
};

/** Every size is at least 44px in both directions: the tap-target floor. */
const sizes: Record<Size, string> = {
  md: "min-h-11 min-w-11 px-3 text-ui",
  lg: "min-h-12 min-w-11 px-5 text-body",
};

type Props = ComponentProps<"button"> & { variant?: Variant; size?: Size };

export function Button({ variant = "primary", size = "md", className = "", type = "button", ...rest }: Props) {
  return <button type={type} className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest} />;
}
