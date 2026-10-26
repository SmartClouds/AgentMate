using System.Globalization;
using Runova.ServerCore.DirectTls;

namespace Runova.ServerCore.Tests;

/// <summary>Reads what the endpoint asks Kestrel for, since the in-memory test server binds nothing.</summary>
internal sealed class FakeDirectTlsBinding(DirectTlsEndpoint endpoint) : IDirectTlsBinding
{
    public bool IsListening(int port) =>
        endpoint.TryGet($"Kestrel:Endpoints:{DirectTlsEndpoint.Name}:Url", out var url)
        && url is not null
        && url.EndsWith(string.Create(CultureInfo.InvariantCulture, $":{port}"), StringComparison.Ordinal);
}
