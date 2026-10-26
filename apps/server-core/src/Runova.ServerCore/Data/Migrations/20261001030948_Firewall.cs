using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations
{
    /// <inheritdoc />
    public partial class Firewall : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "FirewallChangeSets",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Backend = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    State = table.Column<string>(type: "TEXT", maxLength: 30, nullable: false),
                    Summary = table.Column<string>(type: "TEXT", maxLength: 2000, nullable: false),
                    Changes = table.Column<string>(type: "TEXT", nullable: false),
                    Commands = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    DeadlineAt = table.Column<long>(type: "INTEGER", nullable: true),
                    FinishedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    RequestedBy = table.Column<Guid>(type: "TEXT", nullable: true),
                    RequestedByName = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true),
                    DeviceId = table.Column<Guid>(type: "TEXT", nullable: true),
                    AppliedOver = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    AppliedOverSsh = table.Column<bool>(type: "INTEGER", nullable: false),
                    AppliedFrom = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    GuardOverridden = table.Column<bool>(type: "INTEGER", nullable: false),
                    RolledBackBy = table.Column<string>(type: "TEXT", maxLength: 20, nullable: true),
                    Error = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FirewallChangeSets", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_FirewallChangeSets_CreatedAt",
                table: "FirewallChangeSets",
                column: "CreatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_FirewallChangeSets_State",
                table: "FirewallChangeSets",
                column: "State");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "FirewallChangeSets");
        }
    }
}
