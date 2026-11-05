// Adapted from shadcn/ui Base UI registry, commit 8a3536678a528cc012b9e62484290e79d0be410f (MIT).
// The product classes below map the generated controls to DS-Group semantic tokens.
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps, Ref } from "react";
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
      className={cn(
        "ds-input ds-textarea w-full min-w-0 outline-none",
        className,
      )}
      {...props}
    />
  );
}

// Native select preserves HTML form submission, IME and existing preference APIs.
export function NativeSelect({
  className,
  ...props
}: ComponentProps<"select">) {
  return (
    <span className="ds-select-wrap">
      <select
        data-slot="select"
        className={cn("ds-input ds-select w-full min-w-0", className)}
        {...props}
      />
      <ChevronDown aria-hidden="true" size={16} strokeWidth={2} />
    </span>
  );
}

// Base UI mirrors values into hidden inputs for FormData. Its uncontrolled visual
// state does not follow HTMLFormElement.reset(), so remount only that primitive
// when the owning form resets. Controlled callers keep their supplied state.
function useFormReset(
  inputRef: Ref<HTMLInputElement> | undefined,
  formId?: string,
) {
  const node = useRef<HTMLInputElement | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const form =
      node.current?.form ?? (formId ? document.getElementById(formId) : null);
    if (!form) return;
    const reset = (event: Event) => {
      queueMicrotask(() => {
        if (!event.defaultPrevented) setVersion((previous) => previous + 1);
      });
    };
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [version, formId]);
  function connectInput(element: HTMLInputElement | null) {
    node.current = element;
    if (typeof inputRef === "function") inputRef(element);
    else if (inputRef) inputRef.current = element;
  }
  return { version, connectInput };
}

export function Checkbox({
  className,
  inputRef,
  form,
  ...props
}: CheckboxPrimitive.Root.Props) {
  const { version, connectInput } = useFormReset(inputRef, form);
  return (
    <CheckboxPrimitive.Root
      key={version}
      data-slot="checkbox"
      className={cn("ds-checkbox", className)}
      inputRef={connectInput}
      form={form}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="ds-checkbox-indicator">
        <Check aria-hidden="true" size={12} strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function RadioGroup<Value extends string>({
  className,
  inputRef,
  form,
  ...props
}: RadioGroupPrimitive.Props<Value>) {
  const { version, connectInput } = useFormReset(inputRef, form);
  return (
    <RadioGroupPrimitive
      key={version}
      data-slot="radio-group"
      className={cn("ds-radio-group", className)}
      inputRef={connectInput}
      form={form}
      {...props}
    />
  );
}

export function Radio<Value extends string>({
  className,
  ...props
}: RadioPrimitive.Root.Props<Value>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio"
      className={cn("ds-radio", className)}
      {...props}
    >
      <RadioPrimitive.Indicator className="ds-radio-indicator" />
    </RadioPrimitive.Root>
  );
}

export function ColorInput({
  className,
  ...props
}: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      type="color"
      data-slot="color-input"
      className={cn("ds-color-input", className)}
      {...props}
    />
  );
}

export function FileInput({
  className,
  ...props
}: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      type="file"
      data-slot="file-input"
      className={cn("ds-file-input", className)}
      {...props}
    />
  );
}
