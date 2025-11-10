// E2E-003: use cache in async utility function

export async function getCachedData(id: string) {
  "use cache";

  await new Promise((resolve) => setTimeout(resolve, 100));

  return {
    id,
    timestamp: new Date().toISOString(),
    randomValue: Math.random(),
  };
}
