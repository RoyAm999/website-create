import { Suspense } from "react";
import { Leads } from "@/components/leads";
import { Spinner } from "@/components/ui";

export default function LeadsPage() { return <Suspense fallback={<Spinner />}><Leads /></Suspense>; }
