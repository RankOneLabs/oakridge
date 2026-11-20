## Long steps

- Publish a provisional artifact as soon as the work supports it, and publish again with the final numbers.
- Run long commands in the foreground with a polling wait (for example a loop that checks a log or status every 30–60 seconds until done). Never leave a command running in the background across turns.
- Before starting any long step, check that this attempt is still running. If it is not, stop.
- Never end your turn before every artifact this step must publish has been published. Ending early fails the attempt.
