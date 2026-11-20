/** Decorative beside the product name. The browser tab uses the same artwork. */
export function BrandMark({ className }: { className?: string }) {
  return <img className={className} src="/logbook.svg" width={26} height={26} alt="" />;
}
