using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hubs;
using Tapper;
using TypedSignalR.Client;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The TypeScript client is generated from ICoreHub and ICoreHubReceiver. These tests keep the C#
/// side honest: the hub really implements the interface the app is typed against, every method
/// carries its own policy, and every type crossing the wire is marked for transpilation, so the
/// generated TypeScript can never silently miss a type.
/// </summary>
public sealed class CoreHubContractTests
{
    [Fact]
    public void The_hub_implements_the_contract_the_app_is_generated_from()
    {
        Assert.True(typeof(ICoreHub).IsAssignableFrom(typeof(CoreHub)));
        Assert.NotNull(typeof(ICoreHub).GetCustomAttribute<HubAttribute>());
        Assert.NotNull(typeof(ICoreHubReceiver).GetCustomAttribute<ReceiverAttribute>());
    }

    [Fact]
    public void Every_hub_method_names_its_policy()
    {
        var map = typeof(CoreHub).GetInterfaceMap(typeof(ICoreHub));

        var unguarded = map.TargetMethods
            .Where(method => !method.GetCustomAttributes<AuthorizeAttribute>()
                .Any(attribute => !string.IsNullOrEmpty(attribute.Policy)))
            .Select(method => method.Name)
            .ToList();

        Assert.NotEmpty(map.TargetMethods);
        Assert.Empty(unguarded);
    }

    [Fact]
    public void The_hub_exposes_nothing_outside_its_contract()
    {
        var contract = typeof(ICoreHub).GetMethods().Select(method => method.Name).ToHashSet();

        var extra = typeof(CoreHub)
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            // Overrides of the hub's own lifecycle methods (OnConnectedAsync...) are not callable.
            .Where(method => !method.IsSpecialName
                && method.GetBaseDefinition().DeclaringType == typeof(CoreHub)
                && !contract.Contains(method.Name))
            .Select(method => method.Name)
            .ToList();

        Assert.Empty(extra);
    }

    [Fact]
    public void Every_type_on_the_wire_is_transpiled()
    {
        var missing = WireTypes(typeof(ICoreHub))
            .Concat(WireTypes(typeof(ICoreHubReceiver)))
            .Concat([typeof(HealthResponse)])
            .Distinct()
            .Where(type => type.GetCustomAttribute<TranspilationSourceAttribute>() is null)
            .Select(type => type.FullName)
            .ToList();

        Assert.Empty(missing);
    }

    /// <summary>Contract types used by an interface, unwrapped from Task, streams and collections.</summary>
    private static IEnumerable<Type> WireTypes(Type contract) =>
        contract.GetMethods()
            .SelectMany(method => method.GetParameters()
                .Select(parameter => parameter.ParameterType)
                .Append(method.ReturnType))
            .SelectMany(Unwrap)
            .Where(type => type.Namespace == typeof(HealthResponse).Namespace);

    private static IEnumerable<Type> Unwrap(Type type)
    {
        if (type.IsGenericType)
        {
            return type.GetGenericArguments().SelectMany(Unwrap);
        }

        return type.IsArray ? Unwrap(type.GetElementType()!) : [type];
    }
}
