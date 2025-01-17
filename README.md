## Deploy RatGirlX yourself

ℹ️ Currently, we only provide assistance with deploying with Cloudflare Workers, [but it may be possible to run on other web standards-compliant runtimes](https://hono.dev/getting-started/basic).

Clone the repo, install [Node.js](https://nodejs.org/) and run `npm install` in the repo directory. Copy `wrangler.example.toml` to `wrangler.toml` and add your [Cloudflare account ID](https://developers.cloudflare.com/fundamentals/get-started/basic-tasks/find-account-and-zone-ids/), and change the name of your worker if you need to. Also copy `.env.example` to `.env` and change HOST_URL, DIRECT_MEDIA_DOMAINS to your desired domain and whatever else you need to do. Authenticate with Cloudflare with `npx wrangler login`, then do `npm run deploy` (or `npx wrangler deploy --no-bundle`).

[If you have more questions about setting up Cloudflare Workers, check out their Getting Started guide](https://developers.cloudflare.com/workers/get-started/guide/).

Once you're set up with your worker on `*.workers.dev`, [add your worker to your custom domain](https://developers.cloudflare.com/workers/platform/routing/custom-domains/).

Populate Sentry details in your `.env` to use Sentry in your product to catch exceptions.

In 2023, Twitter began blocking posts with NSFW media from the guest API. We use a service binding code-named [elongator](https://github.com/FixTweet/elongator), which use empty Twitter accounts to make these requests successfully. This is an optional component and is only necessary for those who plan to support embedding NSFW tweets. This method also means you never have to pay Elon Musk to use Twitter's official API.

---
