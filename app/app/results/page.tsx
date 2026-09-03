import { Suspense } from "react";
import { Results } from "@/components/results";
import { Spinner } from "@/components/ui";

export default function ResultsPage() { return <Suspense fallback={<Spinner />}><Results /></Suspense>; }
