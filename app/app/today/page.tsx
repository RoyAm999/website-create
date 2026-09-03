import { Suspense } from "react";
import { Today } from "@/components/today";
import { Spinner } from "@/components/ui";

export default function TodayPage() {
  return <Suspense fallback={<Spinner />}><Today /></Suspense>;
}
