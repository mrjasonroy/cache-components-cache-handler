// Test data generators for cacheLife tests
import { cacheLife } from "next/cache";

export async function getTimestampData(id: string) {
  "use cache";
  return {
    id,
    timestamp: new Date().toISOString(),
    random: Math.random(),
  };
}

export async function getSecondsProfileData(id: string) {
  "use cache";
  cacheLife("seconds");

  return {
    id,
    profile: "seconds",
    timestamp: new Date().toISOString(),
    random: Math.random(),
  };
}

export async function getMinutesProfileData(id: string) {
  "use cache";
  cacheLife("minutes");

  return {
    id,
    profile: "minutes",
    timestamp: new Date().toISOString(),
    random: Math.random(),
  };
}

export async function getHoursProfileData(id: string) {
  "use cache";
  cacheLife("hours");

  return {
    id,
    profile: "hours",
    timestamp: new Date().toISOString(),
    random: Math.random(),
  };
}

export async function getDaysProfileData(id: string) {
  "use cache";
  cacheLife("days");

  return {
    id,
    profile: "days",
    timestamp: new Date().toISOString(),
    random: Math.random(),
  };
}

export async function getWeeksProfileData(id: string) {
  "use cache";
  cacheLife("weeks");

  return {
    id,
    profile: "weeks",
    timestamp: new Date().toISOString(),
    random: Math.random(),
  };
}

export async function getMaxProfileData(id: string) {
  "use cache";
  cacheLife("max");

  return {
    id,
    profile: "max",
    timestamp: new Date().toISOString(),
    random: Math.random(),
  };
}

// Inline profile example
export async function getInlineProfileData(id: string) {
  "use cache";
  cacheLife({
    stale: 10, // 10 seconds
    revalidate: 5, // 5 seconds
    expire: 15, // 15 seconds
  });

  return {
    id,
    profile: "inline",
    timestamp: new Date().toISOString(),
    random: Math.random(),
  };
}

// Custom profile from next.config
export async function getBiweeklyProfileData(id: string) {
  "use cache";
  cacheLife("biweekly");

  return {
    id,
    profile: "biweekly",
    timestamp: new Date().toISOString(),
    random: Math.random(),
  };
}

// Custom short profile for testing
export async function getShortProfileData(id: string) {
  "use cache";
  cacheLife("short");

  return {
    id,
    profile: "short",
    timestamp: new Date().toISOString(),
    random: Math.random(),
  };
}
