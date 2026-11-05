// Adapted from shadcn/ui Base UI registry, commit 8a3536678a528cc012b9e62484290e79d0be410f (MIT).
// The product classes below map the generated controls to DS-Group semantic tokens.
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

const buttonVariants = cva(
  "ds-button inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap select-none transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "ds-button-default",
        secondary: "ds-button-secondary",
        ghost: "ds-button-ghost",
        destructive: "ds-button-destructive",
      },
      size: {
        default: "ds-button-size-default",
        sm: "ds-button-size-sm",
        icon: "ds-button-size-icon",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn("ds-input w-full min-w-0 outline-none", className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn("ds-input ds-textarea w-full min-w-0 outline-none", className)}
      {...props}
    />
  );
}

// Native select preserves HTML form submission, IME and existing preference APIs.
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn("ds-input ds-select w-full min-w-0", className)}
      {...props}
    />
  );
}
