// Adapted from shadcn/ui Base UI registry, commit 8a3536678a528cc012b9e62484290e79d0be410f (MIT).
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "./cn";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export function PopoverContent({
  className,
  align = "start",
  side = "bottom",
  sideOffset = 8,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal keepMounted>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="ds-popover-positioner"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn("ds-popover-content outline-none", className)}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export function DialogContent({ className, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal keepMounted>
      <DialogPrimitive.Backdrop className="ds-dialog-backdrop" />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn("ds-dialog-content outline-none", className)}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}
