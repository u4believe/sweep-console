export default function SettingsPage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Settings</h1>

      <div className="space-y-6">
        {/* API Keys */}
        <div className="card p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">API Keys</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Test API Key</p>
                <p className="font-mono text-xs text-gray-500">test_••••••••••••••••••••</p>
              </div>
              <button className="btn-secondary text-xs py-1.5 px-3">Reveal</button>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Live API Key</p>
                <p className="font-mono text-xs text-gray-500">live_••••••••••••••••••••</p>
              </div>
              <button className="btn-secondary text-xs py-1.5 px-3">Reveal</button>
            </div>
          </div>
        </div>

        {/* Webhook Secret */}
        <div className="card p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Webhook Signing Secret</h2>
          <p className="mb-3 text-sm text-gray-600">
            Use this secret to verify that webhook events were sent by SweepConsole.
          </p>
          <div className="rounded-lg bg-gray-50 px-4 py-3">
            <code className="font-mono text-xs text-gray-500">whsec_••••••••••••••••••••</code>
          </div>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-900 p-4 text-xs text-green-400">
{`// Verify in your webhook handler:
const sig = req.headers['x-sweep-signature'];
const body = await req.text();
const expected = 'sha256=' + createHmac('sha256', webhookSecret)
  .update(body).digest('hex');
if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
  return res.status(400).send('Invalid signature');
}`}
          </pre>
        </div>

        {/* Payout Wallet */}
        <div className="card p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Payout Wallet</h2>
          <p className="mb-3 text-sm text-gray-600">
            The Arc wallet address where your USDC revenue is credited after each subscription payment.
          </p>
          <input
            type="text"
            placeholder="0x..."
            className="w-full rounded-lg border border-gray-200 px-4 py-2.5 font-mono
                       text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <button className="btn-primary mt-3 py-2 text-sm">Save Wallet</button>
        </div>
      </div>
    </div>
  );
}
