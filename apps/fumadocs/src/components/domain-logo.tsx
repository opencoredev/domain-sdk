type DomainLogoProps = {
  className?: string;
  title?: string;
};

/**
 * A domain thread passing through an infrastructure boundary.
 *
 * The split outer loop creates the over/under illusion without relying on
 * background-colored masks, so the mark remains truly one-color everywhere.
 */
export function DomainLogo({ className, title }: DomainLogoProps) {
  return (
    <img
      className={className}
      src="/images/domain-sdk-mark.png"
      width={1254}
      height={1254}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      draggable={false}
    />
  );
}
