using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.DirectTls;

/// <summary>
/// Which enrolled device a client certificate stands for. The desktop makes its own certificate,
/// self-signed with its device key, so nothing in it is trusted except the public key: it has to be
/// the P-256 key of a device that is not revoked. The TLS handshake proves the caller holds the
/// private half. Read from the database on every handshake and every request, so a revocation
/// counts at once.
/// </summary>
internal sealed class DirectTlsDevices(IDbContextFactory<CoreDbContext> databases)
{
    private const string ItemKey = "runova:direct-tls-device";

    /// <summary>The device the certificate's key belongs to, or null.</summary>
    public Guid? Find(X509Certificate2? certificate)
    {
        if (certificate is null)
        {
            return null;
        }

        byte[] publicKey;
        try
        {
            publicKey = certificate.PublicKey.ExportSubjectPublicKeyInfo();
        }
        catch (CryptographicException)
        {
            return null;
        }

        if (DeviceKeys.ParsePublicKey(Convert.ToBase64String(publicKey)) is null)
        {
            return null;
        }

        using var db = databases.CreateDbContext();
        var device = db.Devices
            .AsNoTracking()
            .Where(d => d.PublicKey == publicKey && d.RevokedAt == null)
            .Select(d => (Guid?)d.Id)
            .FirstOrDefault();
        return device;
    }

    /// <summary>Whether this request came in over the direct TLS listener.</summary>
    public static bool IsDirect(HttpContext? context) => context?.Features.Get<ITlsConnectionFeature>() is not null;

    /// <summary>The device the request's client certificate proved, set by <see cref="DirectTlsGuard"/>.</summary>
    public static Guid? DeviceOf(HttpContext? context) =>
        context?.Items.TryGetValue(ItemKey, out var value) == true && value is Guid device ? device : null;

    /// <summary>
    /// Whether a request names a device other than the one its certificate proved. Always false off
    /// the TLS listener, where SSH stands behind the caller instead.
    /// </summary>
    public static bool Mismatch(HttpContext? context, Guid deviceId) =>
        IsDirect(context) && DeviceOf(context) != deviceId;

    internal static void Remember(HttpContext context, Guid device) => context.Items[ItemKey] = device;
}

/// <summary>
/// Every request over the direct TLS listener names its device again, from the certificate the
/// handshake checked. A device revoked while its connection stays open is refused on its next
/// request (its hub connections are closed by the revocation itself).
/// </summary>
internal sealed class DirectTlsGuard(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, DirectTlsDevices devices)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(devices);
        var tls = context.Features.Get<ITlsConnectionFeature>();
        if (tls is null)
        {
            await next(context);
            return;
        }

        var certificate = tls.ClientCertificate ?? await tls.GetClientCertificateAsync(context.RequestAborted);
        if (devices.Find(certificate) is not Guid device)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            context.Abort();
            return;
        }

        DirectTlsDevices.Remember(context, device);
        await next(context);
    }
}
