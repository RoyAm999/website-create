import Link from "next/link";
import { Logo } from "@/components/logo";

export default function NotFound() {
  return <main className="simple-page"><Logo /><h1>העמוד הזה לא נמצא.</h1><p>אפשר לחזור למסך היום ולהמשיך משם.</p><Link href="/app/today/" className="button">חזרה להיום</Link></main>;
}
