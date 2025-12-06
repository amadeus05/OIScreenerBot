# Collect all TypeScript files from signal-analyzer module into a single text file
# Usage: .\collect-signal-analyzer.ps1

$sourceDir = "c:\Users\amadeus\Desktop\OITrackerBot\src\domain\signal-analyzer"
$outputFile = "c:\Users\amadeus\Desktop\OITrackerBot\signal-analyzer-full.txt"

# Get all .ts files recursively
$files = Get-ChildItem -Path $sourceDir -Recurse -Filter "*.ts" | Sort-Object FullName

# Clear output file
"" | Out-File -FilePath $outputFile -Encoding utf8

# Header
@"
================================================================================
SIGNAL ANALYZER MODULE - FULL SOURCE CODE
Generated: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Total Files: $($files.Count)
================================================================================

"@ | Out-File -FilePath $outputFile -Encoding utf8 -Append

# Process each file
foreach ($file in $files) {
    $relativePath = $file.FullName.Replace($sourceDir, "").TrimStart("\")
    
    @"

################################################################################
# FILE: $relativePath
# PATH: $($file.FullName)
################################################################################

"@ | Out-File -FilePath $outputFile -Encoding utf8 -Append
    
    Get-Content -Path $file.FullName -Raw | Out-File -FilePath $outputFile -Encoding utf8 -Append
}

# Footer
@"

================================================================================
END OF SIGNAL ANALYZER MODULE
================================================================================
"@ | Out-File -FilePath $outputFile -Encoding utf8 -Append

Write-Host "✅ Collected $($files.Count) files into: $outputFile" -ForegroundColor Green
Write-Host "📄 Files included:" -ForegroundColor Cyan
$files | ForEach-Object { Write-Host "   - $($_.FullName.Replace($sourceDir, ''))" }
