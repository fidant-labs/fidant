import "preact";

declare module "preact" {
  interface HTMLAttributes<RefType extends EventTarget = EventTarget> {
    writingsuggestions?: "true" | "false";
  }
}
