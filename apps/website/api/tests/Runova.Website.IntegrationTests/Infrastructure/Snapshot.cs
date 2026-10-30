using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// Compares JSON with a committed snapshot in the project's Snapshots folder. A missing or
/// different snapshot fails the test and writes <c>name.received.json</c> beside it; rename that
/// file to <c>name.verified.json</c> to accept the change.
/// </summary>
internal static class Snapshot
{
    private static readonly JsonSerializerOptions _indented = new() { WriteIndented = true, IndentSize = 2, NewLine = "\n" };

    public static async Task MatchesJsonAsync(string name, string json)
    {
        var cancel = TestContext.Current.CancellationToken;
        var folder = Path.Combine(ProjectDirectory(), "Snapshots");
        var verified = Path.Combine(folder, name + ".verified.json");
        var received = Path.Combine(folder, name + ".received.json");
        var actual = JsonNode.Parse(json)!.ToJsonString(_indented) + "\n";

        var expected = File.Exists(verified) ? (await File.ReadAllTextAsync(verified, cancel)).ReplaceLineEndings("\n") : null;
        if (expected == actual)
        {
            File.Delete(received);
            return;
        }

        Directory.CreateDirectory(folder);
        await File.WriteAllTextAsync(received, actual, cancel);
        Assert.Fail(expected is null
            ? $"No snapshot yet. Check {received} and rename it to {Path.GetFileName(verified)}."
            : $"{name} differs from its snapshot. Compare {received} with {verified}; rename it over the snapshot if the change is planned.");
    }

    private static string ProjectDirectory() =>
        typeof(Snapshot).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(a => a.Key == "ProjectDirectory").Value!;
}
