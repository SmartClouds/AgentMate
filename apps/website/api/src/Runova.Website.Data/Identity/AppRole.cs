using Microsoft.AspNetCore.Identity;

namespace Runova.Website.Data.Identity;

/// <summary>A staff role: Admin or Editor, both seeded by the first migration.</summary>
public class AppRole : IdentityRole<long>;
