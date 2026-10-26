using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The fallback policy denies anything left unmarked, but relying on it hides intent. Every mapped
/// endpoint has to say either "anonymous" or which policy guards it, so a new route cannot ship
/// with an access decision nobody made.
/// </summary>
public sealed class EndpointAuthorizationCoverageTests(CoreFactory factory) : IClassFixture<CoreFactory>
{
    [Fact]
    public void Every_endpoint_declares_its_authorization()
    {
        var endpoints = factory.Services
            .GetRequiredService<EndpointDataSource>()
            .Endpoints
            .OfType<RouteEndpoint>()
            .ToList();

        Assert.NotEmpty(endpoints);
        var undecided = endpoints
            .Where(endpoint =>
                endpoint.Metadata.GetMetadata<IAllowAnonymous>() is null
                && !endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>()
                    .Any(data => !string.IsNullOrEmpty(data.Policy)))
            .Select(endpoint => endpoint.RoutePattern.RawText)
            .ToList();

        Assert.Empty(undecided);
    }

    /// <summary>A container's files are for Admins (E27): whoever can write them can run anything in it.</summary>
    [Fact]
    public void File_transfers_are_for_admins()
    {
        var files = factory.Services
            .GetRequiredService<EndpointDataSource>()
            .Endpoints
            .OfType<RouteEndpoint>()
            .Where(endpoint => endpoint.RoutePattern.RawText?.StartsWith("/api/v1/files", StringComparison.Ordinal) == true)
            .ToList();

        Assert.Equal(
            ["GET /api/v1/files/{sessionId:guid}/content", "PUT /api/v1/files/{sessionId:guid}/content"],
            files.Select(endpoint => $"{endpoint.Metadata.GetMetadata<Microsoft.AspNetCore.Routing.HttpMethodMetadata>()!.HttpMethods.Single()} {endpoint.RoutePattern.RawText}").Order(StringComparer.Ordinal));
        Assert.All(files, endpoint => Assert.Contains(
            endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>(),
            data => data.Policy == Runova.ServerCore.Security.CorePolicies.Admin));
    }

    /// <summary>Health, and the sign-in steps that run before there is a token.</summary>
    [Fact]
    public void Only_health_and_sign_in_are_anonymous()
    {
        var anonymous = factory.Services
            .GetRequiredService<EndpointDataSource>()
            .Endpoints
            .OfType<RouteEndpoint>()
            .Where(endpoint => endpoint.Metadata.GetMetadata<IAllowAnonymous>() is not null)
            .Select(endpoint => endpoint.RoutePattern.RawText)
            .ToList();

        Assert.Equal(
            ["/api/v1/auth/challenge", "/api/v1/auth/enroll", "/api/v1/auth/login", "/api/v1/auth/renew", "/api/v1/health"],
            anonymous.Order(StringComparer.Ordinal));
    }
}
