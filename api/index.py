import os
import sys

# Ensure root repository directory is on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import app

__all__ = ["app"]
