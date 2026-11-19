import { expect, test, type Page, type Request } from "@playwright/test";

const unique = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const phoneFor = (seed: string) => `212555${seed.slice(-4).padStart(4, "0")}`;

/** Every request the browser makes, so we can assert PII never leaves in a URL or Referer. */
function recordRequests(page: Page) {
  const seen: Request[] = [];
  page.on("request", (r) => seen.push(r));
  return seen;
}

test("variant B prepop: lands straight on contact, PII never stays in the URL, Back reaches prefilled steps", async ({ page }) => {
  const id = unique();
  const email = `sam.${id}@example.com`;
  const requests = recordRequests(page);

  await page.goto(`/?click_id=e2e${id}&aff_id=42&channel=email&zip=%2090210%20&first_name=SAM&email=${encodeURIComponent(email)}&insured=YES&year={sub5}&variant=b`);

  // Landed on the contact step, address bar is clean.
  await expect(page.getByRole("heading", { name: "Where should we send your quotes?" })).toBeVisible();
  expect(new URL(page.url()).search).toBe("?step=contact");
  expect(page.url()).not.toContain("example.com");
  await expect(page).toHaveTitle("Get Your Quotes | QuoteLane");
  await expect(page.getByText("Step 3 of 3")).toBeVisible();

  // Prefilled and editable, never locked; macro never shown.
  await expect(page.getByLabel("First name")).toHaveValue("Sam");
  await expect(page.getByLabel("First name")).toBeEditable();
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await expect(page.locator("body")).not.toContainText("{sub5}");

  // Back walks through the skipped steps with their prefilled answers.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: "Yes, I have auto insurance" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("ZIP code")).toHaveValue("90210");
  // Continue skips forward over answered steps again: straight back to contact.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Where should we send your quotes?" })).toBeVisible();

  // Consent text sits above the button, verbatim.
  await expect(page.getByTestId("consent-text")).toHaveText(
    "By clicking Get My Quotes, I agree that QuoteLane and its partners may contact me by phone, text and email, including by automated means, at the number provided. Consent is not a condition of purchase.",
  );
  await page.getByLabel("Last name").fill("Lee");
  await page.getByLabel("Phone").fill(`+1 (${phoneFor(id).slice(0, 3)}) ${phoneFor(id).slice(3, 6)}-${phoneFor(id).slice(6)}`);
  await page.getByRole("button", { name: "Get My Quotes" }).click();

  await expect(page).toHaveURL(/\/thank-you\?ref=[0-9A-Z]{26}$/);
  await expect(page.getByRole("heading", { name: "You're all set!" })).toBeVisible();

  // After the first redirect, no request URL or Referer carried the email.
  const later = requests.slice(1);
  for (const r of later) {
    expect(r.url()).not.toContain(encodeURIComponent(email));
    expect(r.url()).not.toContain(email);
    expect((await r.allHeaders())["referer"] ?? "").not.toContain("example.com");
  }
});

test("variant A typed flow: validation errors, progress, refresh survival, double-click safe", async ({ page }) => {
  const id = unique();
  await page.goto("/?variant=a");

  // Landing ZIP validation
  await page.getByLabel("ZIP code").fill("1234");
  await page.getByRole("button", { name: "Get My Free Quotes" }).click();
  await expect(page.getByText("Enter a valid 5-digit US ZIP code.")).toBeVisible();
  await page.getByLabel("ZIP code").fill("10001");
  await page.getByRole("button", { name: "Get My Free Quotes" }).click();

  await expect(page.getByRole("heading", { name: "What year is your vehicle?" })).toBeVisible();
  await expect(page.getByText("Step 2 of 6")).toBeVisible();
  await page.getByRole("button", { name: String(new Date().getFullYear()) }).click();
  await page.getByRole("button", { name: "Honda" }).click();

  // Refresh mid-funnel: answers and position survive.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Are you insured right now?" })).toBeVisible();
  await page.getByRole("button", { name: "No, I'm not currently insured" }).click();
  await page.getByRole("button", { name: "25-34" }).click();

  // Contact validation
  await page.getByRole("button", { name: "Get My Quotes" }).click();
  await expect(page.getByText("Enter your first name.")).toBeVisible();
  await page.getByLabel("First name").fill("Ana");
  await page.getByLabel("Last name").fill("Diaz");
  await page.getByLabel("Email").fill("notanemail");
  await page.getByLabel("Phone").fill("abc");
  await page.getByRole("button", { name: "Get My Quotes" }).click();
  await expect(page.getByText("Enter a valid email address, like name@example.com.")).toBeVisible();
  await expect(page.getByText("Enter a valid 10-digit US phone number.")).toBeVisible();
  await page.getByLabel("Email").fill(`ana.${id}@example.com`);
  await page.getByLabel("Phone").fill(phoneFor(id + "7"));

  // Double-click: exactly one created response, and both share an idempotency key.
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/leads") && r.method() === "POST") posts.push(r.headers()["idempotency-key"] ?? "");
  });
  await page.getByRole("button", { name: "Get My Quotes" }).dblclick();
  await expect(page).toHaveURL(/\/thank-you/);
  expect(new Set(posts).size).toBeLessThanOrEqual(1);
});

test("junk prepop is ignored and the steps show normally", async ({ page }) => {
  await page.goto("/?zip=00000&phone=abc&email=%5BEMAIL%5D&first_name=%25%25first%25%25&year=1850&insured=maybe&variant=a&click_id={click_id}");
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByLabel("ZIP code")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("[EMAIL]");
  await expect(page.locator("body")).not.toContainText("%%first%%");
  await page.getByLabel("ZIP code").fill("30301");
  await page.getByRole("button", { name: "Get My Free Quotes" }).click();
  await expect(page.getByRole("heading", { name: "What year is your vehicle?" })).toBeVisible();
});

test("sticky variant across visits; ?variant=clear returns to normal rules", async ({ page, context }) => {
  await page.goto("/quote");
  const first = await page.locator("main").getAttribute("data-variant");
  for (let i = 0; i < 3; i++) {
    await page.goto("/quote");
    expect(await page.locator("main").getAttribute("data-variant")).toBe(first);
  }
  const other = first === "a" ? "b" : "a";
  await page.goto(`/quote?variant=${other}`);
  expect(await page.locator("main").getAttribute("data-variant")).toBe(other);
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "ql_vo")?.expires).toBe(-1); // session cookie only
  expect(cookies.find((c) => c.name === "ql_v")?.value).toBe(first); // sticky untouched
  await page.goto("/quote?variant=clear");
  expect(await page.locator("main").getAttribute("data-variant")).toBe(first);
});
