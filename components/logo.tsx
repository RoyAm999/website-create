import Image from "next/image";
import Link from "next/link";

export function Logo({ href = "/", compact = false }: { href?: string; compact?: boolean }) {
  return (
    <Link href={href} className={`brand-logo ${compact ? "brand-logo--compact" : ""}`} aria-label="Shuv Flow — דף הבית">
      <Image
        src="/shuv-flow-logo.png"
        alt="Shuv Flow — מחזירים פניות למסלול"
        width={1200}
        height={400}
        priority
      />
    </Link>
  );
}
