import { cacheLife, cacheTag, revalidateTag } from "next/cache";
import Link from "next/link";

async function getProducts() {
  "use cache";
  cacheLife("hours"); // Cache for 1 hour
  cacheTag("products");

  await new Promise((resolve) => setTimeout(resolve, 500));

  return [
    { id: 1, name: "Product A", price: 29.99 },
    { id: 2, name: "Product B", price: 49.99 },
    { id: 3, name: "Product C", price: 19.99 },
  ];
}

async function handleRevalidate() {
  "use server";
  revalidateTag("products");
}

export default async function ProductsPage() {
  const products = await getProducts();
  const timestamp = new Date().toISOString();

  return (
    <div>
      <h1>Products (Cached)</h1>

      <p>
        <Link href="/">← Back to home</Link>
      </p>

      <div
        style={{ background: "#f0f0f0", padding: "1rem", margin: "1rem 0", borderRadius: "4px" }}
      >
        <h2>Product List:</h2>
        <p>
          <strong>Fetched at:</strong> {timestamp}
        </p>
        <ul>
          {products.map((product) => (
            <li key={product.id}>
              {product.name} - ${product.price}
            </li>
          ))}
        </ul>
      </div>

      <div
        style={{ background: "#e3f2fd", padding: "1rem", margin: "1rem 0", borderRadius: "4px" }}
      >
        <h3>🏷️ Tagged Cache Revalidation</h3>
        <p>
          This data is cached with tag: <code>products</code>
        </p>
        <form action={handleRevalidate}>
          <button
            type="submit"
            style={{
              padding: "0.5rem 1rem",
              background: "#2196f3",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Revalidate Products Cache
          </button>
        </form>
        <p>
          <small>Click the button to invalidate the cache, then refresh to see new timestamp</small>
        </p>
      </div>
    </div>
  );
}
