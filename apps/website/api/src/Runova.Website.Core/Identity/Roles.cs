namespace Runova.Website.Core.Identity;

/// <summary>The staff roles. Both are seeded by the first migration; there are no others.</summary>
public static class Roles
{
    public const string Admin = "Admin";
    public const string Editor = "Editor";

    public static IReadOnlyList<string> All { get; } = [Admin, Editor];
}
