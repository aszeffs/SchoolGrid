import { expect, test } from "./test.ts";

/**
 * The image names the commit it was built from at /api/build-info, which the
 * README's "How this was built" section points a reader at to check the live
 * site. CI knows which commit it built, so an image that lost its commit
 * between the build arg and the server fails here.
 */
test("the image under test reports the commit it was built from", async ({ request }) => {
  const expected = process.env["SCHOOLGRID_EXPECTED_COMMIT"];
  test.skip(expected === undefined || expected === "", "only CI knows which commit the image was built from");

  const response = await request.get("/api/build-info");

  expect(response.status()).toBe(200);
  expect(((await response.json()) as { commit?: string }).commit).toBe(expected);
});
