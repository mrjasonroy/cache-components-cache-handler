import { cacheTag } from "next/cache";

// User data from database (5s)
async function getUserFromDB() {
  "use cache: remote";
  cacheTag("user-db");

  await new Promise((resolve) => setTimeout(resolve, 5000));

  const userId = Math.random().toString(36).substring(2, 10);
  return {
    userId,
    name: `User-${userId}`,
    timestamp: Date.now(),
    source: "database",
  };
}

// Weather data from external API (5s)
async function getWeatherAPI() {
  "use cache: remote";
  cacheTag("weather-api");

  await new Promise((resolve) => setTimeout(resolve, 5000));

  const weatherId = Math.random().toString(36).substring(2, 10);
  return {
    weatherId,
    temp: Math.floor(Math.random() * 30) + 10,
    condition: ["Sunny", "Cloudy", "Rainy"][Math.floor(Math.random() * 3)],
    timestamp: Date.now(),
    source: "weather-api",
  };
}

// Stock data from external API (5s)
async function getStockAPI() {
  "use cache: remote";
  cacheTag("stock-api");

  await new Promise((resolve) => setTimeout(resolve, 5000));

  const stockId = Math.random().toString(36).substring(2, 10);
  return {
    stockId,
    price: (Math.random() * 1000).toFixed(2),
    change: (Math.random() * 10 - 5).toFixed(2),
    timestamp: Date.now(),
    source: "stock-api",
  };
}

export default async function MultiRemotePage() {
  // All run in parallel - 5s total
  const [user, weather, stock] = await Promise.all([
    getUserFromDB(),
    getWeatherAPI(),
    getStockAPI(),
  ]);

  return (
    <div>
      <h1>Multi-Remote Sources Test</h1>

      <div data-testid="user-section">
        <h2>User Data (Database)</h2>
        <p data-testid="user-id">User ID: {user.userId}</p>
        <p>Name: {user.name}</p>
        <p>Timestamp: {user.timestamp}</p>
        <p>Source: {user.source}</p>
      </div>

      <div data-testid="weather-section">
        <h2>Weather Data (API)</h2>
        <p data-testid="weather-id">Weather ID: {weather.weatherId}</p>
        <p>
          Temperature: {weather.temp}°C - {weather.condition}
        </p>
        <p>Timestamp: {weather.timestamp}</p>
        <p>Source: {weather.source}</p>
      </div>

      <div data-testid="stock-section">
        <h2>Stock Data (API)</h2>
        <p data-testid="stock-id">Stock ID: {stock.stockId}</p>
        <p>
          Price: ${stock.price} (Change: {stock.change}%)
        </p>
        <p>Timestamp: {stock.timestamp}</p>
        <p>Source: {stock.source}</p>
      </div>

      <p className="instruction">
        First load: 5s (parallel). All cached: &lt;1s. Revalidate one tag: only that source
        refetches (5s total).
      </p>
      <a href="/">Back to home</a>
    </div>
  );
}
