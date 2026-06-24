"use client";

import { revalidateTestTag, updateTestTag } from "./actions";

export function RevalidateForms({ tag }: { tag?: string }) {
  return (
    <div>
      <h3>Test Actions:</h3>
      <form
        action={async () => {
          await revalidateTestTag(tag);
          window.location.reload();
        }}
      >
        <button type="submit" data-testid="revalidate-button">
          Revalidate Tag (revalidateTag)
        </button>
      </form>

      <form
        action={async () => {
          await updateTestTag(tag);
          window.location.reload();
        }}
      >
        <button type="submit" data-testid="update-button">
          Update Tag (updateTag)
        </button>
      </form>
    </div>
  );
}
