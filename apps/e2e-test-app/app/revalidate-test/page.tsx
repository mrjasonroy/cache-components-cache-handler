import { getTaggedData } from "@/lib/tagged-data";
import { RevalidateForms } from "./revalidate-form";

// E2E-201-202: Tag-based revalidation

export default async function Page() {
  const data = await getTaggedData("test-tag");

  return (
    <div>
      <h1>E2E-201-202: Revalidation Test</h1>
      <div data-testid="tagged-content">
        <p>Tag: {data.tag}</p>
        <p>Timestamp: {data.timestamp}</p>
        <p>Random: {data.randomValue}</p>
      </div>

      <RevalidateForms />

      <a href="/">Back to home</a>
    </div>
  );
}
