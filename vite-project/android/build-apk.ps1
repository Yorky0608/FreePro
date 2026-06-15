.\gradlew.bat :app:clean :app:assembleDebug
if ($?) {
    Start-Process ".\app\build\outputs\apk\debug\"
}
